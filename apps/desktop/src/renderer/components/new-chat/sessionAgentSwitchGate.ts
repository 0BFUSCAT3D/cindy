/**
 * 会话换 Agent / 换电脑的入口门控。
 *
 * Orca Lead/Worker 可在当前 Agent 位置使用切换事务；用户发起的位置迁移仍受 main 限制。
 * Lead 的远端目录读取失败时，额外开放只回任务本机的入口。
 */

export type RemoteCatalogStatus = 'idle' | 'loading' | 'error' | 'ready';

export function orcaLeadLocalFallbackOpen(input: {
  sessionOrcaRole: string | null | undefined;
  agentDeviceId: string | null | undefined;
  remoteCatalogStatus: RemoteCatalogStatus | undefined;
}): boolean {
  return (
    input.sessionOrcaRole === 'lead' &&
    typeof input.agentDeviceId === 'string' &&
    input.agentDeviceId.length > 0 &&
    input.remoteCatalogStatus === 'error'
  );
}

export function sessionAgentSwitchSupported(input: {
  sessionOrcaRole: string | null | undefined;
  runtimeAgentKind: string | null | undefined;
  hostSwitchCapable: boolean;
}): boolean {
  return (
    input.sessionOrcaRole !== undefined &&
    input.runtimeAgentKind != null &&
    input.hostSwitchCapable
  );
}

/** 离线回落只露出本机格,不把其它电脑列进左栏。 */
export function sessionRemoteAgentDevicesForOrcaFallback<T>(
  devices: readonly T[] | undefined,
  fallbackOpen: boolean,
): readonly T[] {
  if (fallbackOpen) return [];
  return devices ?? [];
}

const FAVORITES_UNREACHABLE_CODES = new Set([
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_LINK_TIMEOUT',
  'DEVICE_LINK_BUSY',
]);

export function favoritesSyncFailureI18nKey(
  errorCode: string | null | undefined,
): 'newChat.modelSelector.unified.favoritesSyncFailedUnreachable' | 'newChat.modelSelector.unified.favoritesSyncFailed' {
  return errorCode && FAVORITES_UNREACHABLE_CODES.has(errorCode)
    ? 'newChat.modelSelector.unified.favoritesSyncFailedUnreachable'
    : 'newChat.modelSelector.unified.favoritesSyncFailed';
}
