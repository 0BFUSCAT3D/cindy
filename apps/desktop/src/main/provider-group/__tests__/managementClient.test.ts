/**
 * 同账号管理的控制端：只转发明确的管理操作；本机生成的链接由本机弹审批窗(provider-sharing.md §4.1 第 4 步)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: 'owner-a' }));
const host = vi.hoisted(() => ({ watch: vi.fn(), forget: vi.fn() }));
const clipboard = vi.hoisted(() => ({ remember: vi.fn() }));

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../../device-link/providerShareHost.js', () => ({
  watchProviderShareRequests: host.watch,
  forgetWatchedProviderShareRequest: host.forget,
}));
vi.mock('../../textClipboard.js', () => ({ rememberIssuedClipboardText: clipboard.remember }));

import { PROVIDER_GROUP_REMOTE_CHANNEL } from '@cindy/device-link';

import type { ProviderManagementRequest } from '../../../shared/providerManagement';
import { invokeProviderManagement } from '../managementClient';
import type { ProviderGroupRemoteInvoke } from '../remoteClient';

function replying(result: unknown): ProviderGroupRemoteInvoke {
  return vi.fn(async () => ({ ok: true, result: { result, respondedAt: Date.now() } })) as unknown as ProviderGroupRemoteInvoke;
}

const createLink: ProviderManagementRequest = { action: 'manage-share', command: { action: 'create-link', providerId: 'anthropic' } };

beforeEach(() => {
  state.owner = 'owner-a';
  host.watch.mockReset();
  host.forget.mockReset();
  clipboard.remember.mockReset();
});

describe('provider management client', () => {
  it('watches the group computer\'s share after generating a link there, so the request prompts here', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const invoke = replying({ link: 'https://cindy.app/s#token', expiresAt });
    const snapshot = { ready: true, shares: [{ shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', requests: [] }] };
    const readInvoke = replying(snapshot);
    const created = await invokeProviderManagement(invoke, 'group-host', createLink, readInvoke) as { link: string };
    expect(invoke).toHaveBeenCalledWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [createLink], expect.anything());
    expect(created.link).toBe('https://cindy.app/s#token');
    expect(clipboard.remember).toHaveBeenCalledWith('https://cindy.app/s#token', expect.any(String));
    expect(host.watch).toHaveBeenCalledWith('group-host', 'anthropic', expect.any(Function));
    const readShares = host.watch.mock.calls[0][2];
    await expect(readShares()).resolves.toEqual(snapshot.shares);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readInvoke).toHaveBeenCalledWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [
      { action: 'manage-share', command: { action: 'owned', range: '7d' } },
    ], expect.anything());
    vi.mocked(readInvoke).mockResolvedValue({ ok: true, result: { result: { ready: false, shares: [] }, respondedAt: Date.now() } });
    await expect(readShares()).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('does not watch when the link response is invalid or the account changed on the way', async () => {
    await expect(invokeProviderManagement(replying({ link: '' }), 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    const switching = vi.fn(async () => {
      state.owner = 'owner-b';
      return { ok: true, result: { result: { link: 'x', expiresAt: new Date().toISOString() }, respondedAt: Date.now() } };
    }) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(switching, 'group-host', createLink)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(host.watch).not.toHaveBeenCalled();
    expect(clipboard.remember).not.toHaveBeenCalled();
  });

  it('drops a watched request once it is approved or rejected here, but not when the group computer refused', async () => {
    await invokeProviderManagement(replying({ ok: true }), 'group-host', { action: 'manage-share', command: { action: 'approve', requestId: 'r1' } });
    await invokeProviderManagement(replying({ ok: true }), 'group-host', { action: 'manage-share', command: { action: 'reject', requestId: 'r2' } });
    expect(host.forget.mock.calls).toEqual([['r1'], ['r2']]);

    const refused = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[NOT_FOUND] gone' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(refused, 'group-host', { action: 'manage-share', command: { action: 'approve', requestId: 'r3' } }))
      .rejects.toThrow('[NOT_FOUND] gone');
    expect(host.forget).toHaveBeenCalledTimes(2);
  });

  it('reports an old group computer as needing an update', async () => {
    const old = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] unknown provider group action' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(old, 'group-host', createLink)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(host.watch).not.toHaveBeenCalled();
  });

  it('forwards conditional writes and never retries a conflict or falls back to an unconditional old-host write', async () => {
    const request: ProviderManagementRequest = {
      action: 'manage-group', command: { action: 'delete-if-current', providerId: 'anthropic', expectedConfig: null },
    };
    const conflict = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[PROVIDER_GROUP_CHANGED] changed' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(conflict, 'group-host', request)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(conflict).toHaveBeenCalledExactlyOnceWith('group-host', PROVIDER_GROUP_REMOTE_CHANNEL, [request], expect.anything());
    const old = vi.fn(async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] unknown provider group action' } })) as unknown as ProviderGroupRemoteInvoke;
    await expect(invokeProviderManagement(old, 'group-host', request)).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(old).toHaveBeenCalledTimes(1);
  });
});
