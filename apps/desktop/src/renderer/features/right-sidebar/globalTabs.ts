/**
 * globalTabs —— 右侧栏「不跟对话」的全局页签。
 *
 * 右侧栏的页签分两类:任务页签(store.ts,按任务分桶、切任务跟着换)与全局页签
 * (本模块,全局一份、切任务留在原位)。全局页签今天只有一种内容:插件视图
 * (kind `plugin-view`,承载插件的 `mainView` 或 `panel` 页面)。
 *
 * 持久化:renderer 自有的 localStorage(按数据所有者分键,重启保留,不经 main),
 * 与旧停靠面板的最小化状态同一条路;`storage` 事件做跨窗口同步(主窗 / 副窗 /
 * 弹出的页签窗口各自一份镜像)。存的是 UI 配置,不是任务数据,所以不进 SQLite。
 *
 * 兼容:插件 manifest 里声明了 `panel`(非 `tab` 形态)的插件,启用后自动以全局页签
 * 出现(reconcileGlobalPluginTabs),用户关掉后记入 dismissed 不再自动加回;卸载即
 * 清掉它的页签与 dismissed 记录,重装再按首次启用处理。`mainView` 插件不自动加,
 * 由左侧栏入口「在侧边栏中打开」加入。
 */

import { useSyncExternalStore } from 'react';

import type { InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import type { TabState } from './types';

const log = createLogger('rightSidebar.globalTabs');

const STORAGE_KEY_PREFIX = 'xdt:rightSidebarGlobalTabs:v1:';
const MAX_GLOBAL_TABS = 20;

export interface PluginViewTabState {
  /** 插件物理实例 id(storage part)。 */
  instanceId: string;
}

export interface GlobalTabsSnapshot {
  tabs: TabState[];
  /** 用户主动关掉过、不再自动加回的插件实例。 */
  dismissedInstanceIds: string[];
}

const EMPTY: GlobalTabsSnapshot = Object.freeze({
  tabs: [],
  dismissedInstanceIds: [],
}) as GlobalTabsSnapshot;

let cache: GlobalTabsSnapshot | null = null;
let cacheOwnerKey: string | null = null;
/** 当前窗口里被激活的全局页签;切任务时保持,选中任务页签时清空。不持久化。 */
let activeGlobalTabId: string | null = null;
const subscribers = new Set<() => void>();
let storageListenerWired = false;

function ownerKey(): string {
  return STORAGE_KEY_PREFIX + (getDataOwnerGeneration().dataOwnerId ?? 'none');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析并清洗持久化数据:坏条目整条丢弃,fail closed 不进状态。 */
export function sanitizeGlobalTabsSnapshot(raw: unknown): GlobalTabsSnapshot {
  if (!isPlainObject(raw)) return EMPTY;
  const tabs: TabState[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.tabs)) {
    for (const entry of raw.tabs) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
      if (entry.kind !== 'plugin-view') continue;
      if (!isPlainObject(entry.state) || typeof entry.state.instanceId !== 'string') continue;
      seen.add(entry.id);
      tabs.push({
        id: entry.id,
        kind: 'plugin-view',
        state: { instanceId: entry.state.instanceId } satisfies PluginViewTabState,
      });
      if (tabs.length >= MAX_GLOBAL_TABS) break;
    }
  }
  const dismissedInstanceIds = Array.isArray(raw.dismissedInstanceIds)
    ? raw.dismissedInstanceIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  return { tabs, dismissedInstanceIds };
}

function load(): GlobalTabsSnapshot {
  try {
    const raw = window.localStorage.getItem(ownerKey());
    if (!raw) return EMPTY;
    return sanitizeGlobalTabsSnapshot(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

function notify(): void {
  for (const cb of [...subscribers]) cb();
}

function ensureStorageListener(): void {
  if (storageListenerWired || typeof window === 'undefined') return;
  storageListenerWired = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== cacheOwnerKey) return;
    cache = null;
    notify();
  });
}

export function getGlobalTabsSnapshot(): GlobalTabsSnapshot {
  const key = ownerKey();
  if (cache === null || cacheOwnerKey !== key) {
    cache = load();
    cacheOwnerKey = key;
    ensureStorageListener();
  }
  return cache;
}

export function getGlobalTabs(): TabState[] {
  return getGlobalTabsSnapshot().tabs;
}

export function isGlobalTabId(tabId: string): boolean {
  return getGlobalTabs().some((tab) => tab.id === tabId);
}

export function findGlobalTab(tabId: string): TabState | null {
  return getGlobalTabs().find((tab) => tab.id === tabId) ?? null;
}

function persist(next: GlobalTabsSnapshot): void {
  const key = ownerKey();
  cache = next;
  cacheOwnerKey = key;
  try {
    if (next.tabs.length === 0 && next.dismissedInstanceIds.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(next));
    }
  } catch (err) {
    log.warn('persist global tabs failed', { err });
  }
  notify();
}

function makeTabId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 加入(或返回已有的)某个插件的全局页签。幂等:同一实例只有一个页签。
 * 用户手动加入会清掉它的 dismissed 记录。
 */
export function addGlobalPluginTab(instanceId: string): TabState | null {
  const current = getGlobalTabsSnapshot();
  const existing = current.tabs.find(
    (tab) => (tab.state as PluginViewTabState | null)?.instanceId === instanceId,
  );
  const dismissed = current.dismissedInstanceIds.filter((id) => id !== instanceId);
  if (existing) {
    if (dismissed.length !== current.dismissedInstanceIds.length) {
      persist({ tabs: current.tabs, dismissedInstanceIds: dismissed });
    }
    return existing;
  }
  if (current.tabs.length >= MAX_GLOBAL_TABS) {
    log.warn('global tab limit reached', { instanceId });
    return null;
  }
  const tab: TabState = {
    id: makeTabId(),
    kind: 'plugin-view',
    state: { instanceId } satisfies PluginViewTabState,
  };
  persist({ tabs: [...current.tabs, tab], dismissedInstanceIds: dismissed });
  return tab;
}

/** 用户关闭全局页签:全局动作,同时记 dismissed,插件不再自动加回。 */
export function removeGlobalTab(tabId: string): void {
  const current = getGlobalTabsSnapshot();
  const tab = current.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  const instanceId = (tab.state as PluginViewTabState).instanceId;
  const dismissed = current.dismissedInstanceIds.includes(instanceId)
    ? current.dismissedInstanceIds
    : [...current.dismissedInstanceIds, instanceId];
  if (activeGlobalTabId === tabId) activeGlobalTabId = null;
  persist({
    tabs: current.tabs.filter((candidate) => candidate.id !== tabId),
    dismissedInstanceIds: dismissed,
  });
  // 页签正弹在独立窗口里:窗口没有内容可交回,直接销毁(与任务页签同一规则)。
  if (!isSidebarTabWindow() && isTabPoppedOut(tabId)) {
    void window.electronAPI?.sidebarTabWindow?.closeForTab(tabId).catch((err) => {
      log.warn('close sidebar tab window for removed global tab failed', { tabId, err });
    });
  }
}

export function reorderGlobalTabs(orderedIds: string[]): void {
  const current = getGlobalTabsSnapshot();
  if (orderedIds.length !== current.tabs.length) return;
  const byId = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const next: TabState[] = [];
  for (const id of orderedIds) {
    const tab = byId.get(id);
    if (!tab) return;
    next.push(tab);
  }
  persist({ tabs: next, dismissedInstanceIds: current.dismissedInstanceIds });
}

/** 页签标题:停靠面板用 panel.title,整页视图用 mainView.title,都没有就用插件名。 */
export function globalTabTitleForGhost(ghost: InstalledGhost): string {
  const { manifest } = ghost;
  return manifest.panel?.title ?? manifest.mainView?.title ?? manifest.name;
}

export function findGlobalTabByInstance(instanceId: string): TabState | null {
  return (
    getGlobalTabs().find(
      (tab) => (tab.state as PluginViewTabState | null)?.instanceId === instanceId,
    ) ?? null
  );
}

/** 停靠形态(非 `tab`)的插件面板 = 应自动出现在右侧栏的全局页签。 */
export function isAutoGlobalPanelGhost(ghost: InstalledGhost): boolean {
  return (
    ghost.enabled !== false &&
    ghost.manifest.panel !== undefined &&
    ghost.manifest.panel.position !== 'tab'
  );
}

/** 插件是否能作为全局页签承载(有 mainView 或停靠形态 panel 的已启用插件)。 */
export function isGlobalTabCapableGhost(ghost: InstalledGhost): boolean {
  return (
    ghost.enabled !== false &&
    (ghost.manifest.mainView !== undefined || isAutoGlobalPanelGhost(ghost))
  );
}

/**
 * 与已装清单对齐(启动 + ghosts:changed):
 *  - 已启用、声明停靠面板、未被用户关掉的插件 → 自动加页签(存量插件兼容:
 *    升级前靶在布局树里的停靠面板,升级后出现在右侧栏,用户什么都不用做);
 *  - 清单里不存在的实例 → 删页签与 dismissed 记录(重装视同首次启用)。
 * 停用的插件页签**保留**(投影时按可用性隐藏),重新启用原位回来。
 */
export function reconcileGlobalPluginTabs(ghosts: readonly InstalledGhost[]): void {
  const current = getGlobalTabsSnapshot();
  const installed = new Map(ghosts.map((ghost) => [installedGhostStoragePart(ghost), ghost]));
  let tabs = current.tabs.filter((tab) =>
    installed.has((tab.state as PluginViewTabState).instanceId),
  );
  const dismissed = current.dismissedInstanceIds.filter((id) => installed.has(id));
  const present = new Set(tabs.map((tab) => (tab.state as PluginViewTabState).instanceId));
  for (const [instanceId, ghost] of installed) {
    if (!isAutoGlobalPanelGhost(ghost)) continue;
    if (present.has(instanceId) || dismissed.includes(instanceId)) continue;
    if (tabs.length >= MAX_GLOBAL_TABS) break;
    tabs = [...tabs, { id: makeTabId(), kind: 'plugin-view', state: { instanceId } }];
    present.add(instanceId);
  }
  if (
    tabs.length === current.tabs.length &&
    tabs.every((tab, index) => tab === current.tabs[index]) &&
    dismissed.length === current.dismissedInstanceIds.length
  ) {
    return;
  }
  if (activeGlobalTabId && !tabs.some((tab) => tab.id === activeGlobalTabId)) {
    activeGlobalTabId = null;
  }
  persist({ tabs, dismissedInstanceIds: dismissed });
}

export function getActiveGlobalTabId(): string | null {
  if (activeGlobalTabId && !isGlobalTabId(activeGlobalTabId)) activeGlobalTabId = null;
  return activeGlobalTabId;
}

/** 选中全局页签(null = 回到任务页签)。只影响本窗口。 */
export function setActiveGlobalTabId(tabId: string | null): void {
  const next = tabId && isGlobalTabId(tabId) ? tabId : null;
  if (next === activeGlobalTabId) return;
  activeGlobalTabId = next;
  notify();
}

export function subscribeGlobalTabs(cb: () => void): () => void {
  getGlobalTabsSnapshot();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** React hook:全局页签列表(引用变化 = 有写入或跨窗口同步)。 */
export function useGlobalTabs(): TabState[] {
  return useSyncExternalStore(subscribeGlobalTabs, getGlobalTabs);
}

export function useActiveGlobalTabId(): string | null {
  return useSyncExternalStore(subscribeGlobalTabs, getActiveGlobalTabId);
}

/** 仅测试用。 */
export function __resetGlobalTabsForTest(): void {
  cache = null;
  cacheOwnerKey = null;
  activeGlobalTabId = null;
  subscribers.clear();
}
