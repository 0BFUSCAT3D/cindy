/**
 * Codex 的后台终端在本机 exec-server 里：还有进程在跑时中继算忙，连接池不能让出名额
 * (对方 Codex 一退出，本机 exec-server 随连接关闭，后台终端就没了)。用固定版本的真实 exec-server。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ExecServerRelay } from '../controller/execServerRelay';
import { ExecutorWorkspace } from '../executor/workspace';

const REPO = path.resolve(__dirname, '../../../../../..');
const CODEX = path.join(REPO, 'apps', 'codex-package-bin', process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');

describe.skipIf(!fs.existsSync(CODEX) || process.platform === 'win32')('exec-server relay busy tracking', () => {
  it('is busy while a started process runs, idle after it closes, and reset drops the exec-server', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-busy-')));
    const workspace = new ExecutorWorkspace({ workingDir: root });
    const messages: Array<{ id?: number; method?: string; params?: { processId?: string }; error?: unknown }> = [];
    let parts = '';
    const relay = new ExecServerRelay({
      codexPath: CODEX,
      cwd: root,
      workspace,
      authorize: (action) => (action.kind === 'exec' && action.command.includes('denied') ? { ok: false, reason: 'no' } : { ok: true }),
      push: async (frames) => {
        for (const frame of frames) {
          if (frame.kind !== 'message') continue;
          parts += frame.data;
          if (!frame.more) { messages.push(JSON.parse(parts)); parts = ''; }
        }
      },
    });
    const send = (message: unknown) => relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    const start = (id: number, processId: string, script: string) => send({ id, method: 'process/start', params: {
      processId, argv: ['/bin/sh', '-c', script], cwd: pathToFileURL(root).href, env: {}, tty: false,
    } });
    try {
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      expect(relay.busy()).toBe(false);
      send({ id: 1, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 1), { timeout: 5000 }).toBeDefined();
      send({ method: 'initialized', params: {} });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(relay.busy()).toBe(false);

      // 闸门拒绝的启动不会留下进程。
      start(2, 'denied', 'echo denied');
      await expect.poll(() => messages.find((item) => item.id === 2)?.error, { timeout: 5000 }).toBeDefined();
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);

      // 短命令跑完就不忙。
      start(3, 'short', 'exit 0');
      await expect.poll(() => messages.some((item) => item.method === 'process/closed' && item.params?.processId === 'short'), { timeout: 5000 }).toBe(true);
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);

      // 还在跑的(如 Codex 的后台终端)算忙。
      start(4, 'long', 'sleep 30');
      await expect.poll(() => messages.some((item) => item.id === 4), { timeout: 5000 }).toBe(true);
      expect(relay.busy()).toBe(true);
      send({ id: 5, method: 'process/terminate', params: { processId: 'long' } });
      await expect.poll(() => messages.some((item) => item.method === 'process/closed' && item.params?.processId === 'long'), { timeout: 5000 }).toBe(true);
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);

      // 让出名额后关掉 exec-server，中继本身还能接新的连接。
      relay.reset();
      expect(relay.busy()).toBe(false);
      relay.handle({ t: 'ws', connId: 'c2', kind: 'open', path: '/ws/exec-server' });
      relay.handle({ t: 'ws', connId: 'c2', kind: 'message', data: JSON.stringify({ id: 9, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } }) });
      await expect.poll(() => messages.find((item) => item.id === 9), { timeout: 5000 }).toBeDefined();
    } finally {
      relay.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
