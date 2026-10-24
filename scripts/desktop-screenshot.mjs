#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPortOwner, cdpJson, discoverInstances, printCandidates, readListeners, selectInstance } from './desktop-screenshot/instances.mjs';
import { connectCdp } from './desktop-screenshot/cdp.mjs';
import { collectIdentities, createReplacer, installMask, readRenderedIdentities } from './desktop-screenshot/masking.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export function parseMask(value) {
  const index = value.indexOf('=');
  if (index <= 0) throw new Error('--mask 需要“原文=替换”，原文不能为空。');
  return { source: value.slice(0, index), replacement: value.slice(index + 1), category: 'custom' };
}
export function parseArgs(args) {
  const options = { mask: true, masks: [], keep: [], padding: 0, delay: 0 };
  const flags = new Map([['--port', 'port'], ['--worktree', 'worktree'], ['--sandbox', 'sandbox'], ['--target', 'target'], ['--selector', 'selector'], ['--padding', 'padding'], ['--output', 'output'], ['--mask-file', 'maskFile'], ['--hover', 'hover'], ['--delay', 'delay']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-mask') options.mask = false;
    else {
      const flag = arg.split('=')[0];
      if (!flags.has(flag) && flag !== '--mask' && flag !== '--keep') throw new Error('未知参数；请运行 pnpm desktop:screenshot --help。');
      const value = arg.includes('=') ? arg.slice(flag.length + 1) : args[++i];
      if (!value || value.startsWith('--')) throw new Error('参数缺少值；请运行 pnpm desktop:screenshot --help。');
      if (flag === '--mask') options.masks.push(parseMask(value));
      else if (flag === '--keep') options.keep.push(value);
      else options[flags.get(flag)] = value;
    }
  }
  for (const [name, min, max] of [['port', 1, 65535], ['padding', 0, 1000], ['delay', 0, 10000]]) {
    if (options[name] === undefined) continue;
    if (!/^\d+$/.test(String(options[name])) || Number(options[name]) < min || Number(options[name]) > max) throw new Error(`${name} 超出允许范围。`);
    options[name] = Number(options[name]);
  }
  if (!options.mask && (options.masks.length || options.maskFile || options.keep.length)) throw new Error('--no-mask 不能与替换或豁免选项同时使用。');
  return options;
}

export function captureClip(bounds, padding = 0) {
  const { viewportWidth, viewportHeight, x = 0, y = 0, width = viewportWidth, height = viewportHeight } = bounds;
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('截图区域不可见。');
  const left = Math.max(0, x - padding), top = Math.max(0, y - padding);
  const right = Math.min(viewportWidth, x + width + padding), bottom = Math.min(viewportHeight, y + height + padding);
  if (right <= left || bottom <= top) throw new Error('截图区域在窗口外；请先将它显示在窗口中。');
  return { x: left, y: top, width: right - left, height: bottom - top, scale: 1 };
}

async function outputPath(options) {
  const output = path.resolve(rootDir, options.output ?? `tmp/desktop-screenshots/${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  if (path.extname(output).toLowerCase() !== '.png') throw new Error('输出文件必须是 .png。');
  // Screenshots are local evidence, never implicitly publishable Git assets.
  const check = candidate => spawnSync('git', ['check-ignore', '--quiet', candidate], { cwd: rootDir }).status === 0;
  if (!check(output)) throw new Error('截图必须保存在 Git 忽略的目录；请使用默认 tmp/desktop-screenshots/。');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const physical = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  if (!check(physical)) throw new Error('输出目录链接到了未忽略的位置；请使用默认输出目录。');
  return output;
}

async function selectPage(port, targetId) {
  const targets = await cdpJson(port, 'list');
  const candidates = targets.filter(t => {
    if (t.type !== 'page' || (targetId && t.id !== targetId)) return false;
    try {
      const url = new URL(t.url);
      return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && ['/', '/index.html'].includes(url.pathname) && !url.search;
    } catch { return false; }
  });
  const matches = [];
  for (const target of candidates) {
    const client = await connectCdp(target.webSocketDebuggerUrl, port);
    try {
      if (await client.evaluate("Boolean(document.getElementById('root') && window.electronAPI?.authListAccounts && window.electronAPI?.deviceLink?.listDevices)")) matches.push(target);
    } finally { client.close(); }
  }
  if (matches.length !== 1) throw new Error('无法唯一识别开发版主窗口；请运行 --list，必要时用 --target 指定主窗口页面。');
  return matches[0];
}

export async function screenshot(client, options, local, { capture = params => client.send('Page.captureScreenshot', params) } = {}) {
  const key = `__cindyScreenshot_${randomUUID().replaceAll('-', '')}`;
  let lockAttempted = false;
  let installed = false;
  let restored = false;
  const evalPage = expression => client.evaluate(expression);
  const restore = async () => {
    if (!installed || restored) return;
    const result = await evalPage(`window[${JSON.stringify(key)}]?.restore()`);
    if (!result || result.failures) throw new Error('页面未能完整还原，请刷新该开发版窗口；截图未写出。');
    restored = true;
  };
  try {
    lockAttempted = true;
    const acquired = await evalPage(`(() => {
      const name = '__cindyDesktopScreenshotLock';
      if (window[name]) return false;
      const key = ${JSON.stringify(key)};
      const lock = { key, timer: setTimeout(() => {
        try { window[key]?.restore(); } finally { if (window[name] === lock) delete window[name]; }
      }, 60000) };
      window[name] = lock;
      return true;
    })()`);
    if (!acquired) throw new Error('该窗口已有截图正在进行；请等它完成后重试。');
    if (options.mask) {
      // Set the cleanup obligation before injection: even an evaluation timeout must
      // attempt restoration. Only counts and booleans leave the renderer.
      installed = true;
      const result = await evalPage(`(async () => {
        const key = ${JSON.stringify(key)};
        const pending = { restore() { delete window[key]; return { failures: 0 }; } };
        window[key] = pending;
        const identities = await (${collectIdentities.toString()})(window.electronAPI, ${JSON.stringify(local)}, ${readRenderedIdentities.toString()});
        if (window[key] !== pending) throw Error('collection-cancelled');
        delete window[key];
        const custom = ${JSON.stringify(options.masks)};
        const result = (${installMask.toString()})({ ...identities, entries: [...identities.entries, ...custom], keep: ${JSON.stringify(options.keep)}, key: ${JSON.stringify(key)} }, ${createReplacer.toString()}, ${readRenderedIdentities.toString()});
        return { ...result, loggedIn: identities.loggedIn };
      })()`);
      console.log(`身份替换：规则 ${result.rules} 条，头像 ${result.avatars} 项；${result.loggedIn ? '已登录' : '未登录/模拟模式'}。`);
    } else console.warn('注意：--no-mask 已关闭身份替换；图片可能包含真实身份或私密内容，发布前请检查。');
    if (options.hover) {
      const point = await evalPage(`(() => { const e = document.querySelector(${JSON.stringify(options.hover)}); if (!e) throw Error('hover'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    }
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    await evalPage('new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
    const audit = async () => {
      if (!options.mask) return;
      const result = await evalPage(`window[${JSON.stringify(key)}]?.audit()`);
      if (result?.uncheckedFrames) throw new Error(`存在无法核验身份的可见嵌入或画布内容（${result.uncheckedFrames} 处），未写出截图；请改用未登录的模拟沙箱，或先关闭该预览。`);
      if (!result || result.fault || result.residual) throw new Error(`身份自查未通过（残留 ${result?.residual ?? '未知'} 项），未写出截图。`);
    };
    await audit();
    const bounds = await evalPage(`(() => {
      const selector = ${JSON.stringify(options.selector ?? null)};
      const e = selector ? document.querySelector(selector) : null;
      if (selector && !e) throw Error('selector');
      const r = e?.getBoundingClientRect();
      return { viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio,
        ...(r ? { x: r.x, y: r.y, width: r.width, height: r.height } : {}) };
    })()`);
    // CDP's surface capture uses the window's native device scale factor; multiplying
    // clip.scale by DPR again would double-scale Retina screenshots.
    const result = await capture({ format: 'png', fromSurface: true, captureBeyondViewport: false, clip: captureClip(bounds, options.padding) });
    await audit();
    await restore();
    if (!await evalPage(`window.__cindyDesktopScreenshotLock?.key === ${JSON.stringify(key)}`)) throw new Error('截图已超过窗口锁时限；未写出图片，请重试。');
    return { data: Buffer.from(result.data, 'base64'), dpr: bounds.dpr };
  } finally {
    try {
      if (installed && !restored) {
        // A pending collector is cancelled too, so a timed-out request cannot
        // install its mask later after the command has already failed.
        try {
          const exists = await evalPage(`Boolean(window[${JSON.stringify(key)}])`);
          if (exists) await restore();
        } catch {
          throw new Error('无法确认页面已还原，请刷新该开发版窗口（也有 60 秒自动还原）；未写出截图。');
        }
      }
    } finally {
      if (lockAttempted) {
        try {
          await evalPage(`(() => {
            const lock = window.__cindyDesktopScreenshotLock;
            if (lock?.key === ${JSON.stringify(key)}) { clearTimeout(lock.timer); delete window.__cindyDesktopScreenshotLock; }
          })()`);
        } catch {
          throw new Error('截图连接已断开，无法确认还原与解锁；请刷新目标窗口或等待 60 秒后重试。');
        }
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(`用法：pnpm desktop:screenshot [选项]
默认：当前 checkout 的唯一开发主窗口，自动替换身份信息，PNG 写到 tmp/desktop-screenshots/。
--list                         列出开发实例和页面
--port N | --worktree PATH | --sandbox NAME   明确选择开发实例
--target ID                    主窗口页面 ID（有歧义时）
--selector CSS --padding N      只截可见区域，可加边距
--mask '原文=替换'              补充规则，可重复
--mask-file FILE                JSON 对象（原文: 替换）或“原文=替换”字符串数组
--keep '原文'                   豁免规则，可重复
--no-mask                      显式关闭替换
--hover CSS --delay MS          悬停并等待提示（最多 10000ms）
--output PATH                  输出到 Git 忽略目录，不覆盖已有文件
截图后自动还原；不改变主题、窗口大小或应用设置。发布前仍须人工检查私密内容。`);
    return;
  }
  if (options.maskFile) {
    try {
      const data = JSON.parse(await fs.readFile(options.maskFile, 'utf8'));
      if (Array.isArray(data)) options.masks.push(...data.map(parseMask));
      else if (data && typeof data === 'object' && Object.values(data).every(v => typeof v === 'string')) options.masks.push(...Object.entries(data).map(([source, replacement]) => ({ source, replacement, category: 'custom' })));
      else throw new Error();
    } catch { throw new Error('无法读取 --mask-file；需要 JSON 对象或“原文=替换”字符串数组，不输出文件内容。'); }
  }
  const instances = await discoverInstances(rootDir);
  if (options.list) { printCandidates(instances, rootDir); return; }
  let selected;
  try { selected = selectInstance(instances, options, rootDir); }
  catch (error) { printCandidates(instances, rootDir); throw error; }
  assertPortOwner(selected, readListeners());
  const version = await cdpJson(selected.port, 'version');
  const browser = await connectCdp(version.webSocketDebuggerUrl, selected.port);
  try {
    const info = await browser.send('SystemInfo.getProcessInfo');
    if (!info.processInfo.some(p => p.type === 'browser' && p.id === selected.pid)) throw new Error('CDP 浏览器 PID 与目标开发实例不一致，拒绝截图。');
  } finally { browser.close(); }
  const target = await selectPage(selected.port, options.target);
  const output = await outputPath(options);
  assertPortOwner(selected, readListeners());
  const client = await connectCdp(target.webSocketDebuggerUrl, selected.port);
  try {
    const result = await screenshot(client, options, { home: os.homedir(), username: os.userInfo().username, hostname: os.hostname() });
    await fs.writeFile(output, result.data, { flag: 'wx', mode: 0o600 });
    console.log(`截图已保存：${path.relative(rootDir, output)}（DPR=${result.dpr}）。发布前请再看一眼。`);
  } finally { client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Filesystem and transport errors can contain raw paths or input values.
    const message = error?.code || error?.name === 'TypeError' ? '文件或连接操作失败；请检查本地输出目录、端口和参数后重试。' : error.message;
    console.error(`desktop:screenshot：${message}`);
    process.exitCode = 1;
  });
}
