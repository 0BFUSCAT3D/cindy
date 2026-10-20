/** taskViewSlot.test — 任务页开页槽(taskView)的假 deps 单测。 */
// - 生产入口与可观察结果:GhostTaskViewSlot.handleRequest 的回执与广播载荷。
// - Bug / 规则依据:插件请求在任务右侧栏打开自己的任务页;落点任务要回给插件绑定。
// - 现有覆盖缺口:新槽。最小失败输入:未声明 taskView、sessionId 形状非法、无任务可落。
// - tier:unit。
import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostTaskViewSlot, type TaskViewSlotDeps } from '../taskViewSlot';

function taskGhost(options: { taskView?: boolean; enabled?: boolean; instanceKey?: string } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 3,
      id: 'sim',
      name: 'Simulator',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.taskView !== false ? { taskView: { html: 'task.html' } } : {}),
    },
    dir: '/fake/sim',
    enabled: options.enabled ?? true,
    ...(options.instanceKey ? { instanceKey: options.instanceKey } : {}),
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<TaskViewSlotDeps> = {}) {
  const pushes: unknown[] = [];
  const deps: TaskViewSlotDeps = {
    getGhost: () => taskGhost(),
    broadcast: vi.fn((payload) => {
      pushes.push(payload);
      return true;
    }),
    focusedSessionId: () => 'focused-session',
    ...overrides,
  };
  return { slot: new GhostTaskViewSlot(deps), pushes };
}

describe('taskViewSlot', () => {
  it('opens in the requested task, or the focused task, and reports where it landed', () => {
    const { slot, pushes } = makeSlot();
    expect(slot.handleRequest('sim', { type: 'task-view-request', sessionId: 'task-1' })).toEqual({ ok: true, sessionId: 'task-1' });
    expect(slot.handleRequest('sim', { type: 'task-view-request' })).toEqual({ ok: true, sessionId: 'focused-session' });
    expect(pushes).toEqual([
      { instanceId: 'sim', sessionId: 'task-1' },
      { instanceId: 'sim', sessionId: 'focused-session' },
    ]);
  });

  it('addresses the exact plugin instance, so a namespaced copy opens its own page', () => {
    const { slot, pushes } = makeSlot({ getGhost: () => taskGhost({ instanceKey: '_ns__acme__sim' }) });
    expect(slot.handleRequest('_ns__acme__sim', {}).ok).toBe(true);
    expect(pushes).toEqual([{ instanceId: '_ns__acme__sim', sessionId: 'focused-session' }]);
  });

  it('refuses plugins without a task page, malformed task ids, and having nowhere to land', () => {
    expect(makeSlot({ getGhost: () => taskGhost({ taskView: false }) }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(makeSlot({ getGhost: () => taskGhost({ enabled: false }) }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(makeSlot().slot.handleRequest('sim', { sessionId: '../x' })).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(makeSlot({ focusedSessionId: () => null }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(makeSlot({ broadcast: () => false }).slot.handleRequest('sim', {})).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});
