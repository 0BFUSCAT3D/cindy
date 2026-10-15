/**
 * 只转发明确的同账号管理操作，不重放写请求；链接在本机 Main 登记后才能复制。
 * 本机生成的链接由本机弹审批窗(provider-sharing.md §4.1)：生成后关注那条分享，本机处理过的申请随即移除。
 */
import { PROVIDER_GROUP_REMOTE_CHANNEL, PROVIDER_SHARE_LINK_TTL_MS } from '@cindy/device-link';

import type { ProviderManagementReply, ProviderManagementRequest } from '../../shared/providerManagement.js';
import type { ProviderShareOwnerState } from '../../shared/providerShare.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { forgetWatchedProviderShareRequest, watchProviderShareRequests } from '../device-link/providerShareHost.js';
import { rememberIssuedClipboardText } from '../textClipboard.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { ProviderGroupRemoteInvoke } from './remoteClient.js';

export async function invokeProviderManagement(
  invoke: ProviderGroupRemoteInvoke,
  deviceId: string,
  request: ProviderManagementRequest,
  readInvoke: ProviderGroupRemoteInvoke = invoke,
): Promise<unknown> {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (activeOwnerScopeKey() !== owner) throwIpcError('PRECONDITION_FAILED', 'The account changed during provider management');
  };
  const startedAt = Date.now();
  const response = await invoke(deviceId, PROVIDER_GROUP_REMOTE_CHANNEL, [request], { preSend: assertOwner });
  assertOwner();
  if (!response.ok) {
    const message = response.error?.message ?? '';
    if (response.error?.code === 'CHANNEL_NOT_ALLOWED' || /unknown provider group action/.test(message)) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Provider management requires an update on the computer with the group');
    }
    throw new Error(/^\[[A-Z_]+\]/.test(message) ? message : '[REMOTE_AGENT_UNAVAILABLE] Provider management failed');
  }
  const reply = response.result as ProviderManagementReply | null;
  if (!reply || typeof reply !== 'object' || !Object.hasOwn(reply, 'result') || !Number.isFinite(reply.respondedAt)) {
    throwIpcError('PRECONDITION_FAILED', 'Invalid provider management response');
  }
  if (request.action === 'manage-share' && request.command.action === 'create-link') {
    const created = reply.result as { link?: unknown; expiresAt?: unknown } | null;
    if (!created || typeof created.link !== 'string' || !created.link || created.link.length > 4096
      || typeof created.expiresAt !== 'string' || !Number.isFinite(Date.parse(created.expiresAt))) {
      throwIpcError('PRECONDITION_FAILED', 'Invalid provider share link');
    }
    const remaining = Math.max(0, Math.min(PROVIDER_SHARE_LINK_TTL_MS, Date.parse(created.expiresAt) - reply.respondedAt)
      - Math.max(0, Date.now() - startedAt));
    const expiresAt = new Date(Date.now() + remaining).toISOString();
    rememberIssuedClipboardText(created.link, expiresAt);
    watchProviderShareRequests(deviceId, request.command.providerId, async () => {
      // 申请属于供应商所在电脑，不能轮询本机 REST 列表来找它的申请。沿用同账号
      // 管理调用的发送前/返回后账号检查；这里只读 owned，不重放任何写操作。
      const snapshot = await invokeProviderManagement(readInvoke, deviceId, {
        action: 'manage-share', command: { action: 'owned', range: '7d' },
      }) as ProviderShareOwnerState | null;
      if (!snapshot?.ready || !Array.isArray(snapshot.shares)) {
        throwIpcError('PRECONDITION_FAILED', 'Provider share snapshot is not available on the managing computer');
      }
      return snapshot.shares;
    });
    return { link: created.link, expiresAt };
  }
  if (request.action === 'manage-share' && (request.command.action === 'approve' || request.command.action === 'reject')) {
    forgetWatchedProviderShareRequest(request.command.requestId);
  }
  return reply.result;
}
