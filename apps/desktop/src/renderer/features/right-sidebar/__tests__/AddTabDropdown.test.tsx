// @vitest-environment jsdom
import { createRef, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { AddTabDropdown } from '../AddTabDropdown';
import { DetachedBotMenuOwnerContext } from '../botMenuOwnerContext';
import { __resetGlobalTabsForTest } from '../globalTabs';
import { __resetTabGroupsForTest } from '../tabGroups';

const m = vi.hoisted(() => ({
  ghosts: [] as unknown[],
  open: vi.fn(async () => undefined),
  rows: new Map<string, { remoteHostId?: string | null; deviceLinkDeviceId?: string | null }>(),
  profiles: [] as Array<{ id: string; sessions: Array<{ id: string; role: string }> }>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Radix 浮层在 jsdom 里不需要真的开合:菜单摊平成按钮,只验证有哪些项、点了做什么。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock('@/features/bots/botStore', () => ({
  useBotProfiles: () => m.profiles,
  canonicalBotSessionId: (bot: { sessions: Array<{ id: string; role: string }> }) =>
    bot.sessions.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { findById: (id: string) => m.rows.get(id) ?? null } }));
vi.mock('../lib/openBotWorkbenchTab', () => ({ openBotWorkbenchTab: m.open }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => m.ghosts }));

function renderMenu(
  sessionId: string,
  onSelect = vi.fn(),
  detachedOwner: { sessionId: string; botId: string; canonical: boolean } | null = null,
) {
  const anchorRef = createRef<HTMLElement>();
  render(
    <DetachedBotMenuOwnerContext.Provider value={detachedOwner}>
      <AddTabDropdown open={false} anchorRef={anchorRef} sessionId={sessionId} onClose={vi.fn()} onSelect={onSelect} />
    </DetachedBotMenuOwnerContext.Provider>,
  );
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Map();
  m.profiles = [{ id: 'bot-1', sessions: [
    { id: 'bot-main', role: 'canonical' }, { id: 'bot-history', role: 'history' },
  ] }];
  m.ghosts = [];
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});
afterEach(cleanup);

it('offers the workbench in a local teammate main task and reopens it with the teammate id', () => {
  const onSelect = renderMenu('bot-main');
  fireEvent.click(screen.getByText('bots.workbench.title'));
  expect(m.open).toHaveBeenCalledWith('bot-main', 'bot-1');
  expect(onSelect).not.toHaveBeenCalled();
});

it('uses the linked identity in a detached window without Bot profiles', () => {
  m.profiles = [];
  renderMenu('bot-main', vi.fn(), { sessionId: 'bot-main', botId: 'bot-1', canonical: true });
  expect(screen.getByText('bots.workbench.title')).toBeTruthy();
  for (const kind of ['review', 'subagents', 'backgroundTasks', 'terminal']) {
    expect(screen.queryByText(`rightSidebar.tabs.kinds.${kind}`)).toBeNull();
  }
  fireEvent.click(screen.getByText('bots.workbench.title'));
  expect(m.open).toHaveBeenCalledWith('bot-main', 'bot-1');
});

it('does not reuse a detached owner after switching to another session', () => {
  m.profiles = [];
  renderMenu('task-1', vi.fn(), { sessionId: 'bot-main', botId: 'bot-1', canonical: true });
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
  expect(screen.getByText('rightSidebar.tabs.kinds.review')).toBeTruthy();
});

it('filters a detached Bot history task without offering the canonical workbench', () => {
  m.profiles = [];
  renderMenu('bot-history', vi.fn(), { sessionId: 'bot-history', botId: 'bot-1', canonical: false });
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
  expect(screen.queryByText('rightSidebar.tabs.kinds.review')).toBeNull();
  expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy();
});

it('keeps the other entries on the generic add path', () => {
  const onSelect = renderMenu('bot-main');
  fireEvent.click(screen.getByText('rightSidebar.tabs.kinds.fileBrowser'));
  expect(onSelect).toHaveBeenCalledWith('file-browser');
  expect(m.open).not.toHaveBeenCalled();
});

it.each([
  ['an ordinary task', 'task-1'],
  ['a teammate history task', 'bot-history'],
])('does not offer the workbench in %s', (_label, sessionId) => {
  renderMenu(sessionId);
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
});

it.each([
  ['SSH remote', { remoteHostId: 'ssh-1' }],
  ['device-link', { deviceLinkDeviceId: 'device-2' }],
])('does not offer the workbench for a %s mirror', (_label, row) => {
  m.rows.set('bot-main', row);
  renderMenu('bot-main');
  expect(screen.queryByText('bots.workbench.title')).toBeNull();
});

// 测试价值
// - 生产入口与可观察结果:「+」菜单插件项;可观察的是选择时把 (tabId, 此前是否已打开) 交给宿主,
//   独立窗口据此对「已打开」的页签切换 / 聚焦,而不是菜单关掉后毫无反应。
// - Bug / 规则依据:review「弹出窗口『+』菜单里已在别处打开的插件项点了没反应」。
// - 现有覆盖缺口:此前已打开的项不通知宿主。
// - 最小失败输入:同一个插件项连点两次。
it('reports whether a plugin tab already existed when its menu item is selected', () => {
  m.ghosts = [
    {
      manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html' } },
      enabled: true,
    },
  ];
  const onGlobalTabSelected = vi.fn();
  render(
    <AddTabDropdown
      open={false}
      anchorRef={createRef<HTMLElement>()}
      sessionId="task-1"
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(screen.getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', false);
  cleanup();
  render(
    <AddTabDropdown
      open={false}
      anchorRef={createRef<HTMLElement>()}
      sessionId="task-1"
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(screen.getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', true);
});
