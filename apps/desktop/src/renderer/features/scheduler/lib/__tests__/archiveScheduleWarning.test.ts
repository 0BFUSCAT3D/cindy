/**
 * archiveScheduleWarning — 归档前的自动化提醒:只算 active 绑定,本机与远程分别取数。
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  getSnapshot: vi.fn(),
  getSessionScheduleBindings: vi.fn(),
}));

vi.mock('../schedulesStore', () => ({
  schedulesStore: { ensure: mocks.ensure, getSnapshot: mocks.getSnapshot },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getSessionScheduleBindings: mocks.getSessionScheduleBindings },
}));

import {
  archiveConfirmDescription,
  archiveScheduleWarningMany,
  loadActiveBoundScheduleNames,
} from '../archiveScheduleWarning';
import { __resetBindingMemoForTest } from '../scheduleBindingIndex';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('loadActiveBoundScheduleNames', () => {
  beforeEach(() => {
    __resetBindingMemoForTest();
    mocks.ensure.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.getSessionScheduleBindings.mockReset().mockReturnValue([]);
  });

  it('只返回本机任务绑定的 active 自动化', async () => {
    mocks.ensure.mockResolvedValue([
      { id: 'a', name: 'Daily', status: 'active', targetSessionId: 'task' },
      { id: 'b', name: 'Paused', status: 'paused', targetSessionId: 'task' },
      { id: 'c', name: 'Other', status: 'active', targetSessionId: 'other' },
    ]);

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }, { id: 'plain' }]);

    expect([...result]).toEqual([['task', ['Daily']]]);
  });

  it('持续会话归档后会换绑新任务继续跑,不提示', async () => {
    mocks.ensure.mockResolvedValue([
      {
        id: 'p',
        name: 'Persistent',
        status: 'active',
        targetSessionId: 'task',
        persistentSession: true,
      },
      { id: 'h', name: 'Heartbeat', status: 'active', targetSessionId: 'task' },
    ]);

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }]);

    expect(result.get('task')).toEqual(['Heartbeat']);
  });

  it('远程任务读远程分片,不回退到本机同 ID', async () => {
    mocks.getSessionScheduleBindings.mockReturnValue([
      { id: 'r', name: 'Remote', status: 'active', targetSessionId: 'task' },
    ]);

    const result = await loadActiveBoundScheduleNames([
      { id: 'task', deviceLinkDeviceId: 'mac-2' },
    ]);

    expect(mocks.getSessionScheduleBindings).toHaveBeenCalledWith('mac-2', 'task');
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(result.get('task')).toEqual(['Remote']);
  });

  it('本机列表加载失败时退回已有快照', async () => {
    mocks.ensure.mockRejectedValue(new Error('offline'));
    mocks.getSnapshot.mockReturnValue([
      { id: 'a', name: 'Cached', status: 'active', targetSessionId: 'task' },
    ]);

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }]);

    expect(result.get('task')).toEqual(['Cached']);
  });

  it('批量提示按绑定了自动化的任务数计数', async () => {
    mocks.ensure.mockResolvedValue([
      { id: 'a', name: 'A', status: 'active', targetSessionId: 't1' },
      { id: 'b', name: 'B', status: 'active', targetSessionId: 't1' },
      { id: 'c', name: 'C', status: 'active', targetSessionId: 't2' },
    ]);

    await expect(
      archiveScheduleWarningMany(t, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
    ).resolves.toBe('ccAgent.sidebar.confirmArchive.scheduleWarningMany{"count":2}');
    mocks.ensure.mockResolvedValue([]);
    await expect(archiveScheduleWarningMany(t, [{ id: 't3' }])).resolves.toBe('');
  });
});

describe('archiveConfirmDescription', () => {
  it('无自动化、无改动时只有基础说明', () => {
    expect(archiveConfirmDescription(t, { dirtyWorktree: false, scheduleNames: [] })).toBe(
      'ccAgent.sidebar.confirmArchive.description',
    );
  });

  it('追加 worktree 警告与自动化提醒', () => {
    const text = archiveConfirmDescription(t, { dirtyWorktree: true, scheduleNames: ['Daily'] });
    expect(
      text.startsWith(
        'ccAgent.sidebar.confirmArchive.description ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning ',
      ),
    ).toBe(true);
    expect(text).toContain('ccAgent.sidebar.confirmArchive.scheduleWarning{"count":1');
  });
});
