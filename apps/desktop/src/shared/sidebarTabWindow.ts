/**
 * 右侧栏「单个页签独立窗口」(sidebar tab window)的跨进程共享类型。
 *
 * 与 shared/rightSidebarWindow.ts(整栏子窗口)的差异:按 **tabId 多实例**。
 * 用户把正在看的页签弹出到自己的窗口,主窗口的侧边栏继续存在并显示其余页签;
 * 弹出窗口关闭 = 页签合并回侧边栏。三方共用:main(controller / IPC)、preload
 * (桥接签名)、renderer(主窗镜像 store + 弹出窗口根组件)。只放纯类型与
 * channel 常量,不放运行时代码。
 */

import type { RsbWindowTabSnapshot } from './rightSidebarWindow.js';

/** 弹出窗口承载页签所需的会话渲染上下文,由主窗在弹出瞬间一次性交付。 */
export interface SidebarTabWindowContext {
  workdir: string | null;
  remoteHostId: string | null;
  /** device-link 会话归属:null = 已确认本机,undefined = 尚未解析。 */
  deviceLinkDeviceId?: string | null;
  subagentsAvailable?: boolean;
}

/** main 指派给某扇弹出窗口的页签身份;窗口整个生命周期只承载这一个页签。 */
export interface SidebarTabWindowAssignment {
  tabId: string;
  sessionId: string;
  context: SidebarTabWindowContext;
}

/** 主窗 → main 的弹出请求。handoff 只对不可持久化会话(device-link 远程)非空。 */
export interface SidebarTabWindowOpenRequest extends SidebarTabWindowAssignment {
  handoff?: RsbWindowTabSnapshot | null;
}

/** 弹出窗口合并回侧边栏时交回的单页签内存态(仅不可持久化会话)。 */
export interface SidebarTabReturnSnapshot {
  sessionId: string;
  tab: { id: string; kind: string; state: unknown };
}

/** 单扇弹出窗口的运行时状态;只在当前进程有效,不跨重启。 */
export interface SidebarTabWindowEntryState {
  sessionId: string;
  /** 窗口是否已经展示(或正在等待首份内容后展示)。 */
  open: boolean;
}

/** 全量状态:tabId → 窗口状态。没有条目 = 该页签没有弹出。 */
export type SidebarTabWindowsState = Record<string, SidebarTabWindowEntryState>;

/** main → 主窗:页签离开弹出窗口,回到侧边栏(合并 / 窗口崩溃)。 */
export interface SidebarTabReturnedPayload {
  sessionId: string;
  tabId: string;
  /** 不可持久化会话交回的内存态;可持久化会话为 null,主窗按 SQLite 刷新。 */
  snapshot: SidebarTabReturnSnapshot | null;
  reason: 'merge' | 'crash';
}

/** main → 所有窗口:某会话的页签持久化数据被其它 renderer 改动。 */
export interface RightSidebarTabsChangedPayload {
  sessionId: string;
}

// ── IPC channel 常量 ──────────────────────────────────────────────────
/** renderer → main(invoke):弹出窗口壳已挂载。 */
export const SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL = 'sidebar-tab-window:renderer-ready';
/** renderer → main(invoke):被指派页签的首份内容已提交。 */
export const SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL =
  'sidebar-tab-window:presentation-ready';
/** renderer → main(invoke):读取本窗口的指派(重载 / 预热窗口晚于指派挂载时用)。 */
export const SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL = 'sidebar-tab-window:get-assignment';
/** renderer → main(invoke):把页签合并回侧边栏并关闭本窗口。 */
export const SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL = 'sidebar-tab-window:merge-back';
/** main → 弹出窗口(send):指派页签。 */
export const SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL = 'sidebar-tab-window:assigned';
/** main → 弹出窗口(send):用户经原生入口关窗,renderer 需带快照调用 merge-back。 */
export const SIDEBAR_TAB_WINDOW_MERGE_REQUESTED_CHANNEL = 'sidebar-tab-window:merge-requested';
/** main → 弹出窗口(send):显示 / 隐藏切换。 */
export const SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL =
  'sidebar-tab-window:visibility-changed';
export const SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL = 'sidebar-tab-window:locale-changed';

/** 原生关窗后等待 renderer 交回快照的上限;超时按无快照合并,窗口不会卡住不关。 */
export const SIDEBAR_TAB_WINDOW_MERGE_GRACE_MS = 1_500;
