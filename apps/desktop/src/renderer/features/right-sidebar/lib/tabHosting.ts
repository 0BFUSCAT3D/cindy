/**
 * tabHosting —— 「这个页签的内容由本 renderer 承载吗」。
 *
 * 同一会话的页签桶可能同时水合在两个 renderer 里:主窗侧边栏 + 若干弹出的单页签
 * 窗口。每个页签只由一个 renderer 真正挂载它的 body(webview / 终端 / 文件树),
 * 其它 renderer 只持有它的数据副本:
 *   - 主窗 / 副窗:承载所有**未弹出**的页签;
 *   - 弹出窗口:只承载被指派给它的那一个页签。
 *
 * store 据此决定跨 renderer 刷新时哪些页签以本地为准(承载方)、哪些以 SQLite
 * 为准(非承载方),Shell 据此隐藏非承载页签。
 */

import { isSidebarTabWindow } from '@/lib/sidebarTabWindow';
import { isTabPoppedOut } from '@/lib/sidebarTabWindowState';

let soloTabId: string | null = null;

/** 弹出窗口收到指派后登记自己承载的页签;主窗不调用。 */
export function setSoloTabId(tabId: string | null): void {
  soloTabId = tabId;
}

export function getSoloTabId(): string | null {
  return soloTabId;
}

export function isTabHostedHere(tabId: string): boolean {
  if (isSidebarTabWindow()) return soloTabId !== null && tabId === soloTabId;
  return !isTabPoppedOut(tabId);
}

/** 仅测试用。 */
export function __resetTabHostingForTest(): void {
  soloTabId = null;
}
