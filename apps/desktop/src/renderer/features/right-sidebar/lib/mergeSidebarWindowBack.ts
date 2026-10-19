/**
 * 分离侧栏窗口「合并回主窗口」的唯一出口。
 *
 * 不可持久化会话(device-link 远程)的 tab 只在本 renderer 内存里，必须随
 * setDetached(false) 交接给主窗；可持久化会话的快照为 null，主窗按 SQLite 重新水合。
 */

import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { getSingleTabSnapshot, getTabSnapshot } from '../store';
import { getSoloTabId } from './tabHosting';

export async function mergeSidebarWindowBack(sessionId: string | null | undefined): Promise<void> {
  // 单页签独立窗口:只交回自己承载的那个页签(不可持久化会话附内存态),窗口随之关闭。
  if (isSidebarTabWindow()) {
    const tabId = getSoloTabId();
    const snapshot = tabId ? getSingleTabSnapshot(sessionId, tabId) : null;
    await window.electronAPI.sidebarTabWindow?.mergeBack?.(snapshot);
    return;
  }
  const snapshot = getTabSnapshot(sessionId);
  const handoff = snapshot ? { snapshots: [snapshot] } : undefined;
  await window.electronAPI.rightSidebarWindow.setDetached(false, handoff);
}
