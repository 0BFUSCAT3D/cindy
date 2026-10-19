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
  getActiveGlobalTabId,
  getGlobalTabs,
  getGlobalTabsSnapshot,
  removeGlobalTab,
  reorderGlobalTabs,
  sanitizeGlobalTabsSnapshot,
  setActiveGlobalTabId,
} from '../globalTabs';

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  setDataOwnerGeneration('owner-a', 1);
});

afterEach(() => {
  __resetGlobalTabsForTest();
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
    });
    expect(sanitizeGlobalTabsSnapshot('nope')).toEqual({ tabs: [], dismissedInstanceIds: [] });
  });
});
