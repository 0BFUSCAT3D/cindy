/**
 * 测试价值：openLocalAgentRuntime 的发送、停止和关闭是授权撤销的最终执行点。
 * 规则：通用 API 撤销后不能再启动或发送；原投影测试没有跨 await 的生命周期覆盖。
 * 最小失败输入：setEffort 或重开会话挂起时并发 send / interrupt / close。
 * tier: integration（只使用系统临时目录与可控原生句柄，无 Electron、模型或账号）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('@cindy/maker-core', () => ({ LOCAL_AGENT_CLIENT: Symbol('local-agent-client') }));
import { openLocalAgentRuntime } from '../runtime.js';
import type { AgentEvent } from '@cindy/maker-core';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function handle(id: string) {
  const ended = deferred();
  return {
    sdkSessionId: id,
    send: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setEffort: vi.fn(async () => {}),
    setInteractionListener: vi.fn(),
    onEvent: vi.fn((_listener: (event: AgentEvent) => void) => () => {}),
    onStatusChange: vi.fn(),
    beginTurnContinuationWait: vi.fn<() => string | null>(() => null),
    getObservedCurrentTurnTerminal: vi.fn(() => ({ kind: 'none' })),
    close: vi.fn(async () => {
      ended.resolve();
    }),
  };
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-local-runtime-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const first = handle('first');
  const maker = { startLocalAgentSession: vi.fn(async () => first) };
  const runtime = await openLocalAgentRuntime(
    maker as any,
    directory,
    {
      isolationKey: 'grant-a',
      mcpName: 'client',
      legacyRuntime: false,
      cwd: directory,
      model: {
        id: 'route',
        label: 'Model',
        provider: 'provider',
        model: 'model',
        engine: 'pi',
        efforts: ['high'],
        images: false,
        isDefault: true,
      },
      access: 'none',
      tools: [],
    },
    { url: 'http://127.0.0.1:1/mcp/fixture', token: 'invalid-fixture-token', emit: () => {} },
  );
  cleanups.push(() => runtime.close());
  return { runtime, maker, first };
}
const message = { parts: [{ type: 'text', text: 'hello' }], effort: 'high' };

describe('local client runtime lifecycle', () => {
  it('passes slash-prefixed app text as a literal instead of rejecting paths or running a native command', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: [{ type: 'text', text: '/workspace/example' }] });
    expect(f.first.send).toHaveBeenCalledWith({
      type: 'user',
      content: [{ type: 'text', text: ' /workspace/example' }],
    });
  });
  it('keeps the app execution busy across a provider continuation until Session observes its final boundary', async () => {
    const f = await fixture();
    await f.runtime.call('send', { parts: message.parts });
    const deliver = f.first.onEvent.mock.calls[0][0];
    f.first.beginTurnContinuationWait.mockReturnValueOnce('active');
    deliver({ type: 'done', turnContinuationId: 7, data: { status: 'completed' } });
    await expect(f.runtime.call('send', { parts: message.parts })).rejects.toMatchObject({
      code: 'BUSY',
    });
    f.first.getObservedCurrentTurnTerminal.mockReturnValue({ kind: 'done' });
    deliver({ type: 'done', data: { status: 'completed' } });
    await f.runtime.call('send', { parts: message.parts });
    expect(f.first.send).toHaveBeenCalledTimes(2);
  });
  it('reserves a send before awaiting effort so a concurrent send cannot double-submit', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    await entered.promise;
    const rejected = expect(f.runtime.call('send', message)).rejects.toMatchObject({
      code: 'BUSY',
    });
    held.resolve();
    await sending;
    await rejected;
    expect(f.first.send).toHaveBeenCalledTimes(1);
  });
  it('does not send after an interrupt arrives during effort preparation', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.setEffort.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'INTERRUPTED' });
    await entered.promise;
    await f.runtime.call('interrupt', {});
    held.resolve();
    await rejected;
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('does not restart an engine after close during an instructions rebuild', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.first.close.mockImplementation(async () => {
      entered.resolve();
      await held.promise;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    const closing = f.runtime.close();
    held.resolve();
    await closing;
    await rejected;
    expect(f.maker.startLocalAgentSession).toHaveBeenCalledTimes(1);
    expect(f.first.send).not.toHaveBeenCalled();
  });
  it('closes a late replacement engine instead of sending after its grant was closed', async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred(),
      late = handle('late');
    cleanups.push(() => late.close());
    f.maker.startLocalAgentSession.mockImplementationOnce(async () => {
      entered.resolve();
      await held.promise;
      return late;
    });
    await f.runtime.call('instructions', { instructions: 'new context' });
    const sending = f.runtime.call('send', message);
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' });
    await entered.promise;
    await f.runtime.close();
    held.resolve();
    await rejected;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.close).toHaveBeenCalledWith({ reason: 'account-boundary' });
    expect(late.send).not.toHaveBeenCalled();
  });
});
