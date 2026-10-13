/**
 * 供应商分享受邀者任务的「本任务总是允许」，按任务记在本机主进程内存里
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 *
 * 执行器随 Agent 实例关闭，而 Agent 实例会被系统回收后重建(如 Orca Worker 一轮结束后释放进程)。
 * 只记在执行器里时，这类重建会让用户每轮都要重新确认。这里按「任务 + 分享」记住授权时的原始权限档
 * (含计划模式)：
 *  - 重建时原始权限档与授权时一致才恢复，不一致即作废(任何入口改的权限档都能认出来)；
 *  - 运行中切换权限档由执行器删除；没有运行实例时，用户改权限档的入口调用 forgetCredentialGrants，
 *    认出「切走又切回」。
 * 删除只会让用户多确认一次，不会少确认。不落盘，退出应用即失效。
 */

export interface CredentialGrantRecord {
  /** 新执行器启动时调用：之前在同一权限档下授权过就返回 true；权限档不一致时作废记录。 */
  restore(permission: string): boolean;
  /** 本机用户选择了「本任务总是允许」。 */
  remember(permission: string): void;
  /** 权限档变化：授权失效。 */
  forget(): void;
}

/** 任务 → 分享(Agent 所在的 `share:` 设备) → 授权时的原始权限档。 */
const grants = new Map<string, Map<string, string>>();

/** 原始权限档与计划模式合成比较用的值；不归并(`default` 与 `ask` 也算不同)。 */
export function credentialGrantPermission(permissionMode: string | null | undefined, planMode: boolean): string {
  return JSON.stringify([permissionMode ?? null, planMode]);
}

/** 某个任务在某个分享上的授权记录。 */
export function credentialGrantFor(sessionId: string, deviceId: string): CredentialGrantRecord {
  const forget = () => {
    const byDevice = grants.get(sessionId);
    if (!byDevice) return;
    byDevice.delete(deviceId);
    if (byDevice.size === 0) grants.delete(sessionId);
  };
  return {
    restore(permission) {
      if (grants.get(sessionId)?.get(deviceId) === permission) return true;
      forget();
      return false;
    },
    remember(permission) {
      let byDevice = grants.get(sessionId);
      if (!byDevice) {
        byDevice = new Map();
        grants.set(sessionId, byDevice);
      }
      byDevice.set(deviceId, permission);
    },
    forget,
  };
}

/** 任务的权限档或计划模式被用户修改(包括没有运行实例时)：作废这个任务在所有分享上的授权。 */
export function forgetCredentialGrants(sessionId: string): void {
  grants.delete(sessionId);
}
