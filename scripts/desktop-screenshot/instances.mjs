import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { collectDesktopWhoamiReport } from '../desktop-whoami.mjs';

export function parseListeners(text, platform = process.platform) {
  if (platform === 'win32') {
    const rows = JSON.parse(text || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(r => ({ pid: Number(r.OwningProcess), port: Number(r.LocalPort) }));
  }
  let pid;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    const match = line.match(/^n(?:127\.0\.0\.1|\[::1\]|\*):(\d+)$/);
    if (pid && match) rows.push({ pid, port: Number(match[1]) });
  }
  return rows;
}

export function readListeners() {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'powershell.exe' : 'lsof', windows
    ? ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen | Select-Object OwningProcess,LocalPort) | ConvertTo-Json -Compress"]
    : ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('无法核对监听端口归属；请确认 lsof（macOS/Linux）或 Get-NetTCPConnection（Windows）可用。');
  return parseListeners(result.stdout);
}

const samePath = (a, b) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
};
export function sandboxName(instance) {
  return path.basename(instance.userDataDir ?? '').replace(/^.*?-dev2(?:-|$)/, '') || '(未命名)';
}

export function selectInstance(instances, options, rootDir) {
  let matches = instances;
  if (options.worktree) matches = matches.filter(i => samePath(i.rootDir, options.worktree));
  else if (!options.port && !options.sandbox) matches = matches.filter(i => samePath(i.rootDir, rootDir));
  if (options.sandbox) matches = matches.filter(i => sandboxName(i) === options.sandbox);
  if (options.port) matches = matches.filter(i => i.ports.includes(options.port));
  if (matches.length !== 1) throw new Error(matches.length
    ? '匹配到多个开发实例；请用 --port、--worktree 或 --sandbox 明确选择。'
    : '没有匹配的开发实例；请先启动当前 checkout 的开发版，或用 --list 查看候选。');
  const selected = matches[0];
  if (!selected.ready) throw new Error('目标开发实例尚未就绪；请等启动命令返回 DESKTOP_DEV_VERDICT=ready。');
  if (!selected.ports.length) throw new Error('目标实例没有可用的 CDP 端口（可能被先启动的实例占用）；请用独立 XDT_CDP_PORT 启动它。');
  if (!options.port && selected.ports.length !== 1) throw new Error('目标实例有多个 CDP 端口；请用 --port 明确选择。');
  return { ...selected, port: options.port ?? selected.ports[0] };
}

export function assertPortOwner(instance, listeners) {
  const owners = new Set(listeners.filter(r => r.port === instance.port).map(r => r.pid));
  if (owners.size !== 1 || !owners.has(instance.pid)) {
    throw new Error('CDP 端口不属于选中的开发实例，已拒绝连接；请运行 --list 后重新选择。');
  }
}

export async function cdpJson(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}/json/${endpoint}`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!response.ok) throw new Error('CDP 发现失败。');
  return response.json();
}

export async function discoverInstances(rootDir) {
  const report = collectDesktopWhoamiReport({ rootDir, all: true });
  const listeners = readListeners();
  // A record alone is insufficient: whoami's ready bit also requires a matching
  // checkout Electron main + live renderer. Never probe installed applications.
  return Promise.all(report.instances.map(async instance => {
    const ports = [];
    const pages = [];
    const ownedPorts = [...new Set(listeners.filter(r => r.pid === instance.pid).map(r => r.port))];
    const candidates = instance.cdpPorts?.length ? instance.cdpPorts.filter(port => ownedPorts.includes(port)) : ownedPorts;
    if (instance.ready) await Promise.all(candidates.map(async port => {
      try {
        const version = await cdpJson(port, 'version');
        if (!version.webSocketDebuggerUrl || !version.Browser) return;
        const targets = await cdpJson(port, 'list');
        if (!Array.isArray(targets)) return;
        ports.push(port);
        pages.push(...targets.filter(t => t.type === 'page').map(t => ({ port, id: t.id, url: t.url })));
      } catch { /* Non-CDP listeners owned by Electron are not candidates. */ }
    }));
    return { ...instance, ports: ports.sort((a, b) => a - b), pages };
  }));
}

export function printCandidates(instances, rootDir) {
  console.log('开发实例候选（页面只显示 origin，避免输出查询参数和标题）：');
  for (const i of instances) {
    const root = i.rootDir === rootDir ? '<当前 checkout>' : i.rootDir.replace(os.homedir(), '~');
    console.log(`  worktree=${root} sandbox=${sandboxName(i)} region=${i.region ?? '?'} PID=${i.pid} CDP=${i.ports.join(',') || '未开启'}${i.cdpPorts?.length && !i.ports.length ? ` requested=${i.cdpPorts.join(',')}` : ''}`);
    for (const page of i.pages) {
      let origin = '(非 HTTP 页面)';
      try { if (/^https?:/.test(page.url)) origin = new URL(page.url).origin; } catch { /* omit invalid URLs */ }
      console.log(`    port=${page.port} target=${page.id} page=${origin}`);
    }
  }
  if (!instances.length) console.log('  无。请用 restart:desktop:remote 启动独立开发实例。');
}
