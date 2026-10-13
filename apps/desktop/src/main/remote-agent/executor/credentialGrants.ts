/**
 * 供应商分享受邀者任务的「本任务总是允许」，按任务记在本机主进程内存里
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 *
 * 执行器随 Agent 实例关闭，而 Agent 实例会被系统回收后重建(如 Orca Worker 一轮结束后释放进程)。
 * 只记在执行器里时，这类重建会让用户每轮都要重新确认。这里按「任务 + 分享」记住授权时的权限档：
 * 重建时权限档一致才恢复，不一致即作废；权限档变化时由执行器删除。不落盘，退出应用即失效。
 */
import type { ExecutorGateMode } from './gate';

export interface CredentialGrantRecord {
  /** 新执行器启动时调用：之前在同一权限档下授权过就返回 true；权限档不一致时作废记录。 */
  restore(mode: ExecutorGateMode): boolean;
  /** 本机用户选择了「本任务总是允许」。 */
  remember(mode: ExecutorGateMode): void;
  /** 权限档变化：授权失效。 */
  forget(): void;
}

const grants = new Map<string, ExecutorGateMode>();

/** 某个任务在某个分享(Agent 所在的 `share:` 设备)上的授权记录。 */
export function credentialGrantFor(sessionId: string, deviceId: string): CredentialGrantRecord {
  const key = JSON.stringify([sessionId, deviceId]);
  return {
    restore(mode) {
      const granted = grants.get(key);
      if (granted === mode) return true;
      grants.delete(key);
      return false;
    },
    remember(mode) {
      grants.set(key, mode);
    },
    forget() {
      grants.delete(key);
    },
  };
}
