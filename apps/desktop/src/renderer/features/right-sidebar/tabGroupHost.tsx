import { createContext, useContext } from 'react';

/**
 * 页签组 pane(左 / 上 / 下边组)运行所需的宿主上下文。右侧组由 MainLayout 直接
 * 构造 <RightSidebar>(经 BuiltinPanelBridge 下发);其余边组是布局引擎按需挂载的
 * 通用 pane,所需的会话渲染上下文从这里取 —— 与右侧栏拿到的完全同一份。
 */
export interface TabGroupHostValue {
  sessionId: string | null;
  workdir: string;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
  subagentsAvailable?: boolean;
  isMac: boolean;
  /** 「在独立窗口中打开」某个页签(带 windowId = 搬进已有窗口);副窗口不提供。 */
  onDetachTab?: (tabId: string, targetWindowId?: string) => void;
  /**
   * mac 下窗口左上的红绿灯 / ChromeActions 会盖住最左面板的顶栏:左侧组贴着窗口
   * 顶边且左栏收起 / rail 时,为它们预留 no-drag 空位。
   */
  reserveLeftChromeActions: boolean;
}

const TabGroupHostContext = createContext<TabGroupHostValue | null>(null);

export const TabGroupHostProvider = TabGroupHostContext.Provider;

export function useTabGroupHost(): TabGroupHostValue | null {
  return useContext(TabGroupHostContext);
}
