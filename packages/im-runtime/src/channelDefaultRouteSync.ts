import type { ImDefaultRoute } from "./channelDefaultRoute";

export interface ImChannelDefaultRouteSync {
  /**
   * 本条消息若会触发跟随切换, 返回将要切到的目标路由(新默认可用才返回), 供
   * 发送前的授权检查按真实会跑的路由判断 —— 旧默认坏掉时不能先被「缺授权」挡掉。
   * 只读, 不登记任何东西。
   */
  previewSwitchTarget(sessionId: string): Promise<ImDefaultRoute | null>;
  /**
   * 在 send 锁内对齐。从不抛错。
   * 返回 true = 跟随切换被暂缓(会话有后台工作 / 待处理交互) —— 调用方本次不得再走
   * 通用意图应用(那里的忙判定只看 isTurnRunning, 会立即应用刚登记的意图、跨引擎时
   * 重建仍在承载后台工作的会话, PR #5155 review P1)。
   */
  syncUnderLock(sessionId: string): Promise<boolean>;
  /**
   * 未接线(无运行实例)的任务在接线前先对齐, 避免先用可能已坏的旧路由起一次进程。
   * 自己取放 send 锁, 从不抛错。
   */
  syncBeforeWiring(sessionId: string): Promise<void>;
}
