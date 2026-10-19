/**
 * 分离侧栏窗口「合并回主窗口」的唯一出口。
 *
 * 不可持久化会话(device-link 远程)的 tab 只在本 renderer 内存里,必须随
 * setDetached(false) 交接给主窗;可持久化会话的快照为 null,主窗按 SQLite 重新水合。
 */

import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { getSingleTabSnapshot, getTabSnapshot } from '../store';

export async function mergeSidebarWindowBack(
  sessionId: string | null | undefined,
  tabId?: string,
): Promise<void> {
  // 页签独立窗口:只交回指定的那个页签(不可持久化会话附内存态);窗口清空后 main 关窗。
  if (isSidebarTabWindow()) {
    if (!tabId) return;
    const snapshot = getSingleTabSnapshot(sessionId, tabId);
    await window.electronAPI.sidebarTabWindow?.mergeBack?.({ tabId, snapshot });
    return;
  }
  const snapshot = getTabSnapshot(sessionId);
  const handoff = snapshot ? { snapshots: [snapshot] } : undefined;
  await window.electronAPI.rightSidebarWindow.setDetached(false, handoff);
}
