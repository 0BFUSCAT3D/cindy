// @vitest-environment jsdom
// - 生产入口与可观察结果:openPluginTaskTab 对真实 store 的写入(任务桶里的页签、激活页签、可见性请求)。
// - Bug / 规则依据:同一任务里每个插件实例至多一个任务页;不同任务各有自己的一份。
// - 现有覆盖缺口:新入口。最小失败输入:同一插件在同一任务里连开两次。
// - tier:unit。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetStore, addTab, ensureHydrated, getBucket } from '../../store';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { openPluginTaskTab } from '../openPluginTaskTab';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '../sidebarCommands';

vi.mock('../detachedSidebarRouting', () => ({ routeSidebarCommand: vi.fn(async () => 'attached') }));

type Row = { id: string; sessionId: string; kind: string; position: number; state: unknown };
const rows = new Map<string, Row>();
const active = new Map<string, string | null>();
const ipc = {
  list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    tabs: [...rows.values()].filter((row) => row.sessionId === sessionId).sort((a, b) => a.position - b.position),
    activeTabId: active.get(sessionId) ?? null,
  })),
  upsert: vi.fn(async (row: Row) => { rows.set(row.id, row); }),
  close: vi.fn(async ({ id }: { id: string }) => { rows.delete(id); }),
  setActive: vi.fn(async ({ sessionId, id }: { sessionId: string; id: string | null }) => { active.set(sessionId, id); }),
  reorder: vi.fn(async () => {}),
};
const visibility = vi.fn();

beforeEach(() => {
  _resetStore(); _resetSidebarCommandsForTests();
  rows.clear(); active.clear(); localStorage.clear(); vi.clearAllMocks();
  vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  window.electronAPI = { localDb: { rightSidebarTabs: ipc }, platform: 'darwin' } as unknown as Window['electronAPI'];
  onRequestRightSidebarVisibility(visibility);
});
afterEach(() => { _resetStore(); _resetSidebarCommandsForTests(); });

const taskTabs = (sessionId: string) =>
  getBucket(sessionId).tabs.filter((tab) => tab.kind === 'plugin-task').map((tab) => tab.state);

describe('openPluginTaskTab', () => {
  it('keeps one task page per plugin per task, refocusing it instead of adding another', async () => {
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    await ensureHydrated('task-1');
    const files = await addTab('task-1', 'file-browser');
    expect(getBucket('task-1').activeTabId).toBe(files.id);
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    expect(taskTabs('task-1')).toEqual([{ instanceId: 'sim' }]);
    const simTab = getBucket('task-1').tabs.find((tab) => tab.kind === 'plugin-task')!;
    expect(getBucket('task-1').activeTabId).toBe(simTab.id);
    expect(visibility).toHaveBeenLastCalledWith('open', { sessionId: 'task-1', userInitiated: false });
  });

  it('gives every task its own page, and every plugin its own tab within a task', async () => {
    await openPluginTaskTab('task-1', 'sim');
    await openPluginTaskTab('task-2', 'sim');
    await openPluginTaskTab('task-1', 'other');
    expect(taskTabs('task-1')).toEqual([{ instanceId: 'sim' }, { instanceId: 'other' }]);
    expect(taskTabs('task-2')).toEqual([{ instanceId: 'sim' }]);
  });

  it('leaves the tab to the detached sidebar window when the command is routed there', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');
    await openPluginTaskTab('task-1', 'sim', { userInitiated: false });
    expect(routeSidebarCommand).toHaveBeenCalledWith({ type: 'open-plugin-task', sessionId: 'task-1', instanceId: 'sim' }, { userInitiated: false });
    expect(ipc.upsert).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledWith('open', { sessionId: 'task-1', userInitiated: false });
  });
});
