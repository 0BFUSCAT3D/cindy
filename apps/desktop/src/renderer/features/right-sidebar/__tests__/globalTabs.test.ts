// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:globalTabs 的 add / remove / reorder / active 与 localStorage 持久化;
 *   可观察的是全局页签列表按数据所有者分键保存、用户关闭后记入 dismissed、另一个窗口的
 *   写入通过 storage 事件同步进来、激活位只认仍在列表里的页签。
 * - Bug / 规则依据:右侧栏「不跟对话」的全局页签(本 PR);多窗口共享同一份列表是产品承诺
 *   (弹出的页签窗口与主窗看到同一组全局页签)。
 * - 现有覆盖缺口:ghostPanels.test 只覆盖与已装清单的对齐,不覆盖用户动作与跨窗口同步。
 * - 最小失败输入:加一个页签后切换 owner、或在另一窗口写 localStorage。
 * - tier:unit(jsdom localStorage + storage 事件)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  defaultGroupForGhost,
  getActiveGlobalTabId,
  getGlobalTabs,
  getGlobalTabsSnapshot,
  hasPluginPlacementMemory,
  isPluginWindowPlacement,
  rememberPluginWindowPlacement,
  removeGlobalTab,
  reorderGlobalTabs,
  resetPluginPlacement,
  sanitizeGlobalTabsSnapshot,
  setActiveGlobalTabId,
} from '../globalTabs';
import { __resetTabGroupsForTest, getTabGroup, setTabGroup } from '../tabGroups';

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  window.localStorage.clear();
});

describe('globalTabs', () => {
  it('adds one tab per plugin instance, persists per data owner and remembers dismissals', () => {
    const tab = addGlobalPluginTab('alpha')!;
    expect(addGlobalPluginTab('alpha')).toBe(tab);
    expect(getGlobalTabs()).toHaveLength(1);
    expect(window.localStorage.getItem('xdt:rightSidebarGlobalTabs:v1:owner-a')).toContain('alpha');

    // 另一个数据所有者看不到这份列表。
    setDataOwnerGeneration('owner-b', 1);
    expect(getGlobalTabs()).toEqual([]);
    setDataOwnerGeneration('owner-a', 1);
    expect(getGlobalTabs()).toHaveLength(1);

    setActiveGlobalTabId(tab.id);
    expect(getActiveGlobalTabId()).toBe(tab.id);
    removeGlobalTab(tab.id);
    expect(getGlobalTabs()).toEqual([]);
    expect(getGlobalTabsSnapshot().dismissedInstanceIds).toEqual(['alpha']);
    // 关掉的页签不再是激活位;用户主动重新加入会清掉关闭记录。
    expect(getActiveGlobalTabId()).toBeNull();
    addGlobalPluginTab('alpha');
    expect(getGlobalTabsSnapshot().dismissedInstanceIds).toEqual([]);
  });

  it('reorders only with a complete id list and picks up writes from other windows', () => {
    const a = addGlobalPluginTab('alpha')!;
    const b = addGlobalPluginTab('beta')!;
    reorderGlobalTabs([b.id]);
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual([a.id, b.id]);
    reorderGlobalTabs([b.id, a.id]);
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual([b.id, a.id]);

    // 另一个窗口写入同一键:storage 事件让本窗口重新读取。
    const key = 'xdt:rightSidebarGlobalTabs:v1:owner-a';
    window.localStorage.setItem(
      key,
      JSON.stringify({
        tabs: [{ id: 'g_other', kind: 'plugin-view', state: { instanceId: 'gamma' } }],
        dismissedInstanceIds: [],
      }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(getGlobalTabs().map((tab) => tab.id)).toEqual(['g_other']);
  });

  it('drops malformed persisted entries instead of loading them', () => {
    expect(
      sanitizeGlobalTabsSnapshot({
        tabs: [
          { id: 'ok', kind: 'plugin-view', state: { instanceId: 'alpha' } },
          { id: 'ok', kind: 'plugin-view', state: { instanceId: 'dup' } },
          { id: 'bad-kind', kind: 'terminal', state: {} },
          { id: 'bad-state', kind: 'plugin-view', state: null },
          'junk',
        ],
        dismissedInstanceIds: ['x', 3, ''],
      }),
    ).toEqual({
      tabs: [{ id: 'ok', kind: 'plugin-view', state: { instanceId: 'alpha' } }],
      dismissedInstanceIds: ['x'],
      placedInstanceIds: [],
      windowInstanceIds: [],
    });
    expect(sanitizeGlobalTabsSnapshot('nope')).toEqual({
      tabs: [],
      dismissedInstanceIds: [],
      placedInstanceIds: [],
      windowInstanceIds: [],
    });
  });

  // 测试价值
  // - 生产入口与可观察结果:addGlobalPluginTab({ghost}) / removeGlobalTab / resetPluginPlacement /
  //   rememberPluginWindowPlacement;可观察的是页签 id 跟插件实例走(关掉再打开同一 id)、首次
  //   出现按 panel.position / mainView.side 放默认边、关掉再打开保留用户拖到的边、「恢复默认
  //   位置」清掉窗口记忆并回到默认边。
  // - Bug / 规则依据:页签组模型第三阶段——插件给默认放置,用户的放置记忆优先。
  // - 现有覆盖缺口:新行为。
  // - 最小失败输入:一个 panel.position:'bottom' 的插件 + add → setTabGroup('top') → remove → add。
  // - tier:unit(jsdom localStorage)。
  it('keeps placement memory per plugin instance and resets it on demand', () => {
    const ghost = (position?: 'left' | 'right' | 'top' | 'bottom', mainView?: object) =>
      ({
        manifest: {
          id: 'beta',
          name: 'Beta',
          ...(position !== undefined || mainView === undefined
            ? { panel: { html: 'p.html', ...(position ? { position } : {}) } }
            : {}),
          ...(mainView ? { mainView: { html: 'm.html', ...mainView } } : {}),
        },
        enabled: true,
      }) as unknown as import('../../../../shared/ghost').InstalledGhost;

    const tab = addGlobalPluginTab('beta', { ghost: ghost('bottom') })!;
    expect(tab.id).toBe('g_beta');
    expect(getTabGroup('g_beta')).toBe('bottom');
    // 用户拖到上方,关掉再打开:还在上方,不重新套默认边。
    setTabGroup('g_beta', 'top');
    removeGlobalTab('g_beta');
    expect(addGlobalPluginTab('beta', { ghost: ghost('bottom') })!.id).toBe('g_beta');
    expect(getTabGroup('g_beta')).toBe('top');
    expect(hasPluginPlacementMemory('beta')).toBe(true);

    // 弹过窗口的记忆;恢复默认位置 = 清窗口记忆、回到声明的边。
    rememberPluginWindowPlacement('beta', true);
    expect(isPluginWindowPlacement('beta')).toBe(true);
    resetPluginPlacement('beta', ghost('bottom'));
    expect(isPluginWindowPlacement('beta')).toBe(false);
    expect(getTabGroup('g_beta')).toBe('bottom');

    // 缺省 position 的停靠面板 → left(与历史停靠面板一致);mainView.side 优先。
    expect(defaultGroupForGhost(ghost(undefined))).toBe('left');
    expect(defaultGroupForGhost(ghost(undefined, { open: 'sidebar', side: 'right' }))).toBe('right');
    expect(defaultGroupForGhost(ghost(undefined, { open: 'page' }))).toBe('right');
  });
});
