/**
 * 会话换 Agent / 换电脑的入口门控。
 *
 * 协同任务默认不开放跨电脑切换(handler 对 orcaRole 拒 UNSUPPORTED_CAPABILITY)。
 * 唯一产品例外:Orca Lead 的 Agent 落在另一台电脑、且那台目录读取失败时,只开放切回本机。
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
  hostSwitchCapable: boolean;
  orcaLeadLocalFallback: boolean;
}): boolean {
  if (!input.hostSwitchCapable) return false;
  if (input.sessionOrcaRole === null) return true;
  return input.orcaLeadLocalFallback;
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
