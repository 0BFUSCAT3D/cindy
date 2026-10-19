/**
 * pluginPlacement —— 左侧栏插件入口点下去,主视图在哪里打开。
 *
 * 决策顺序(用户的放置记忆 > 插件声明的默认 > 内置默认):
 *   1. 页签已经在某扇独立窗口里 → 聚焦那扇窗口;
 *   2. 页签已经在侧边栏的某个组里 → 选中它(右侧组收着就展开);
 *   3. 用户上次把它弹到了独立窗口(windowInstanceIds)→ 再开进窗口;
 *   4. 插件 manifest 的 mainView.open:'sidebar' / 'window';
 *   5. 内置默认:撑满内容区的页面(由调用方 navigate)。
 * 放进侧边栏时的默认边同样是记忆优先(tabGroups 里的组归属),其次 mainView.side /
 * panel.position,最后右侧组(见 globalTabs.defaultGroupForGhost)。
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import type { InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { createLogger } from '@/lib/logger';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';
import {
  addGlobalPluginTab,
  findGlobalTabByInstance,
  isPluginWindowPlacement,
  rememberPluginWindowPlacement,
  removeGlobalTab,
  setActiveGlobalTabId,
  useGlobalTabs,
} from './globalTabs';
import { requestRightSidebarVisibility } from './lib/sidebarCommands';
import { getTabGroup } from './tabGroups';

const log = createLogger('rightSidebar.pluginPlacement');

export type PluginOpenTarget = 'page' | 'sidebar' | 'window';

/** 左侧栏入口点击时的打开目标(不含「已在侧边栏 / 窗口里」的聚焦分支)。 */
export function resolvePluginOpenTarget(ghost: InstalledGhost): PluginOpenTarget {
  const instanceId = installedGhostStoragePart(ghost);
  const existing = findGlobalTabByInstance(instanceId);
  if (existing) return isTabPoppedOut(existing.id) ? 'window' : 'sidebar';
  if (isPluginWindowPlacement(instanceId)) return 'window';
  const open = ghost.manifest.mainView?.open;
  if (open === 'sidebar' || open === 'window') return open;
  return 'page';
}

/** 作为全局页签放进侧边栏(默认边见模块说明),选中它;落在右侧组时展开右侧栏。 */
export function openPluginInSidebar(ghost: InstalledGhost): void {
  const instanceId = installedGhostStoragePart(ghost);
  const tab = addGlobalPluginTab(instanceId, { ghost });
  if (!tab) return;
  rememberPluginWindowPlacement(instanceId, false);
  setActiveGlobalTabId(tab.id);
  if (getTabGroup(tab.id) === 'right') requestRightSidebarVisibility('open');
}

/** 弹到独立窗口(已弹出则聚焦那扇窗口)。只在主窗口可用:弹出请求只接受主窗 sender。 */
export function openPluginInWindow(ghost: InstalledGhost): void {
  const instanceId = installedGhostStoragePart(ghost);
  const api = window.electronAPI?.sidebarTabWindow;
  const tab = addGlobalPluginTab(instanceId, { ghost });
  if (!tab || !api) return;
  rememberPluginWindowPlacement(instanceId, true);
  if (isTabPoppedOut(tab.id)) {
    void api.focus(tab.id).catch((err) => log.warn('focus plugin window failed', { err }));
    return;
  }
  if (!api.open) {
    // 副窗口没有弹出权:退回侧边栏。
    setActiveGlobalTabId(tab.id);
    return;
  }
  void api
    .open({
      tabId: tab.id,
      sessionId: null,
      context: { workdir: null, remoteHostId: null },
      handoff: null,
    })
    .catch((err) => log.warn('pop out plugin view failed', { instanceId, err }));
}

/** 已在侧边栏 / 窗口里的页签:聚焦它。返回 false = 还没有页签。 */
export function focusExistingPluginTab(ghost: InstalledGhost): boolean {
  const instanceId = installedGhostStoragePart(ghost);
  const existing = findGlobalTabByInstance(instanceId);
  if (!existing) return false;
  if (isTabPoppedOut(existing.id)) {
    void window.electronAPI?.sidebarTabWindow?.focus(existing.id).catch(() => undefined);
    return true;
  }
  setActiveGlobalTabId(existing.id);
  if (getTabGroup(existing.id) === 'right') requestRightSidebarVisibility('open');
  return true;
}

/** 单实例视图(缺省):同一插件视图同一时刻只活在一个地方。插件声明 mainView.multiple 才放开。 */
export function isSingleInstanceView(ghost: InstalledGhost): boolean {
  return ghost.manifest.mainView?.multiple !== true;
}

/**
 * 整页(/apps/<id>)的单实例守卫:
 *   - 进整页时该实例的页签还在侧栏 / 独立窗口里 → 收掉页签(用户明确选了整页,整页赢;
 *     弹出窗口随之关闭);
 *   - 整页开着时页签又出现(用户点了「在侧边栏中打开」/ 弹出)→ 整页让位,回主入口。
 * 两份同一界面各自保存整份数据会互相覆盖,主机在这里兜底;声明了 multiple 的插件不管。
 */
export function useSingleInstanceViewGuard(ghost: InstalledGhost | null): void {
  const navigate = useNavigate();
  const globalTabs = useGlobalTabs();
  const instanceId = ghost ? installedGhostStoragePart(ghost) : null;
  const single = ghost ? isSingleInstanceView(ghost) : false;
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!instanceId || !single) {
      settledRef.current = null;
      return;
    }
    const existing = globalTabs.find(
      (tab) => (tab.state as { instanceId?: string } | null)?.instanceId === instanceId,
    );
    if (settledRef.current !== instanceId) {
      // 刚进整页:页签在别处就收掉。
      settledRef.current = instanceId;
      if (existing) removeGlobalTab(existing.id);
      return;
    }
    if (existing) {
      // 整页开着时页签出现:整页让位。
      navigate('/', { replace: true });
    }
  }, [globalTabs, instanceId, navigate, single]);
}
