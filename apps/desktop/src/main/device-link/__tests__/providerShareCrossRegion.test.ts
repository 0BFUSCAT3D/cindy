/**
 * 跨区域受邀者(P3)：只认两个官方区域；不把本区域 Access Token 发给对方区域，也不会因对方区域的
 * 401 登出本账号；只有发过申请或加入过分享的账号才会联系对方区域；凭证只在内存里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'a'.repeat(43);
const CREDENTIAL = 'c'.repeat(43);
const LOCAL = 'https://device-link.cindy.com.cn';
const PEER = 'https://device-link.cindy.app';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; opts: Record<string, unknown> }>,
  responses: new Map<string, unknown>(),
  clients: [] as Array<{ opts: Record<string, unknown>; started: boolean; stopped: boolean }>,
  localReceivedError: false,
}));

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
vi.mock('ws', () => ({ default: class {} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'user-1', ownerGeneration: 1 }),
}));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => 'cn',
  getAuthState: () => ({ isAuthenticated: true }),
  getCurrentUserId: () => 'user-1',
  getDeviceId: () => 'device-1',
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => LOCAL,
  loadClientEndpointsForRealm: async () => ({}),
  getClientEndpointForRealm: (region: string) => (region === 'global' ? PEER : LOCAL),
}));
vi.mock('../../maker-host/outbound-fetch.js', () => ({ createOutboundHttpAgent: async () => undefined }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Laptop' }));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: async (apiPath: string, opts: Record<string, unknown>) => {
    state.calls.push({ path: apiPath, opts });
    const key = apiPath.replace('/api/device-link/provider-shares/x', '');
    if (!state.responses.has(key)) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    return state.responses.get(key);
  },
}));
vi.mock('../providerShareApi.js', () => ({
  providerShareOwnerKey: () => 'user-1',
  providerShareApi: {
    listReceived: async () => {
      if (state.localReceivedError) throw new Error('local unavailable');
      return [{ ...share, shareId: 'share-local', memberId: 'member-local', owner: { ...share.owner, region: 'cn' } }];
    },
  },
  fetchIdentityCard: async (purpose: string, nonce: string) => `card:${purpose}:${nonce}`,
  rethrowProviderShareError: (error: unknown) => { throw error; },
  sha256Hex: (value: string) => `h(${value})`.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
}));
vi.mock('@cindy/device-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cindy/device-link')>()),
  DeviceLinkClient: class {
    record: { opts: Record<string, unknown>; started: boolean; stopped: boolean };
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, started: false, stopped: false };
      state.clients.push(this.record);
    }
    start() { this.record.started = true; }
    stop() { this.record.stopped = true; }
  },
}));

import {
  __testing,
  crossRegionOfIntent,
  crossRegionSendRequest,
  getCrossRegionReceived,
  getConfirmedCrossRegionReceivedRegions,
  refreshProviderShareCrossRegion,
  isCrossRegionProviderShareTarget,
  startProviderShareCrossRegion,
  stopProviderShareCrossRegion,
} from '../providerShareCrossRegion';
import { providerShareHostPeer } from '@cindy/device-link';
import { getReceivedSharesSnapshot, refreshReceivedShares, startProviderShareGuest, stopProviderShareGuest } from '../providerShareGuest';

const share = {
  shareId: 'share-x', memberId: 'member-x', providerId: 'openai', providerLabel: 'OpenAI', hostDeviceId: 'owner-pc',
  deviceName: 'Studio', owner: { displayName: 'Ann', avatarUrl: null, region: 'global' }, status: 'active',
  hostOnline: true, hostCapable: true,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-x-'));
  __testing.setUserDataDir(dir);
  state.calls = [];
  state.responses = new Map();
  state.clients = [];
  state.localReceivedError = false;
});
afterEach(() => {
  stopProviderShareGuest();
  stopProviderShareCrossRegion();
  __testing.setUserDataDir(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cross-region provider share', () => {
  it('recovers a revoked region from favorite hints after its marker is removed and the runtime restarts', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.responses.set('/session', { credential: null, expiresAt: null, shares: [] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await refreshProviderShareCrossRegion('global');
    expect(__testing.readMarkers()).toEqual({});
    stopProviderShareGuest();
    state.calls = [];
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
    getReceivedSharesSnapshot({ ownerStamp: { dataOwnerId: 'other', ownerGeneration: 1 }, regions: ['global'] });
    getReceivedSharesSnapshot({ ownerStamp: { dataOwnerId: 'user-1', ownerGeneration: 0 }, regions: ['global'] });
    await Promise.resolve();
    expect(state.calls).toEqual([]);
    const recovery = { ownerStamp: { dataOwnerId: 'user-1', ownerGeneration: 1 }, regions: ['global'] as const };
    // 立即返回本区域快照；多个窗口同时恢复只发一次对方区域请求。
    expect(getReceivedSharesSnapshot(recovery).confirmedRegions).toEqual(['cn']);
    getReceivedSharesSnapshot(recovery);
    await refreshProviderShareCrossRegion('global');
    expect(getReceivedSharesSnapshot(recovery).confirmedRegions).toEqual(['cn', 'global']);
    expect(state.calls.filter((call) => call.path.endsWith('/session'))).toHaveLength(1);
  });

  it('keeps network backoff when favorite recovery is requested repeatedly', async () => {
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    const recovery = { ownerStamp: { dataOwnerId: 'user-1', ownerGeneration: 1 }, regions: ['global'] as const };
    getReceivedSharesSnapshot(recovery);
    await refreshProviderShareCrossRegion('global');
    expect(state.calls).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) getReceivedSharesSnapshot(recovery);
    await Promise.resolve();
    expect(state.calls).toHaveLength(1);
    expect(getReceivedSharesSnapshot().confirmedRegions).toEqual(['cn']);
  });

  it.each(['local', 'peer'] as const)('confirms the available region independently when %s list loading fails', async (failed) => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.localReceivedError = failed === 'local';
    if (failed === 'local') state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), shares: [share] });
    startProviderShareGuest({ changed: vi.fn(), settled: vi.fn() }, { userDataDir: dir });
    await refreshReceivedShares('test');
    await refreshProviderShareCrossRegion('global');
    const snapshot = getReceivedSharesSnapshot();
    expect(snapshot.confirmedRegions).toEqual([failed === 'local' ? 'global' : 'cn']);
    expect(snapshot.received.map((item) => item.shareId)).toEqual([failed === 'local' ? 'share-x' : 'share-local']);
  });

  it('does not confirm an incomplete or failed peer list for favorite cleanup', async () => {
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    await refreshProviderShareCrossRegion('global');
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
    state.responses.set('/session', { credential: null, expiresAt: null, deviceId: 'x:cn:abc', shares: [] });
    await refreshProviderShareCrossRegion('global');
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual(['global']);
    stopProviderShareCrossRegion();
    expect(getConfirmedCrossRegionReceivedRegions()).toEqual([]);
  });
  it('only accepts the two official regions', async () => {
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: LOCAL }, LOCAL)).resolves.toBeNull();
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: PEER }, LOCAL)).resolves.toBe('global');
    await expect(crossRegionOfIntent({ invitation: TOKEN, server: 'https://evil.example' }, LOCAL)).rejects.toThrow();
  });

  it('sends requests with an identity card only and remembers the region without secrets', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    const sent = await crossRegionSendRequest('global', TOKEN);
    expect(sent.requestToken).toBe(TOKEN);
    expect(state.calls[0].opts).toMatchObject({ token: null, skipAutoRefresh: true, skipSessionInvalidation: true, baseUrl: PEER });
    expect(state.calls[0].opts.headers).toBeUndefined();
    expect((state.calls[0].opts.body as { identityCard: string }).identityCard).toMatch(/^card:share-request:/);
    const markers = __testing.readMarkers();
    expect(Object.values(markers)).toEqual([['global']]);
    expect(fs.readFileSync(path.join(dir, 'remote-agent', 'provider-share-regions.json'), 'utf8')).not.toContain(TOKEN);
  });

  it('contacts the peer region only for marked accounts, then connects with the share credential', async () => {
    startProviderShareCrossRegion({ changed: vi.fn() }, { userDataDir: dir });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.calls).toHaveLength(0);
    stopProviderShareCrossRegion();

    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.calls = [];
    state.responses.set('/session', { credential: CREDENTIAL, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), deviceId: 'x:cn:abc', shares: [share] });
    const changed = vi.fn();
    startProviderShareCrossRegion({ changed }, { userDataDir: dir });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(state.calls[0].path).toBe('/api/device-link/provider-shares/x/session');
    expect(state.calls[0].opts.token).toBeNull();
    expect(getCrossRegionReceived().map((item) => item.shareId)).toEqual(['share-x']);
    expect(isCrossRegionProviderShareTarget(providerShareHostPeer('share-x', 'owner-pc'))).toBe(true);
    expect(isCrossRegionProviderShareTarget(providerShareHostPeer('share-y', 'owner-pc'))).toBe(false);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0].opts.authorizationScheme).toBe('ProviderShareGuest');
    await expect((state.clients[0].opts.getToken as () => Promise<string | null>)()).resolves.toBe(CREDENTIAL);
    expect((state.clients[0].opts.getHello as () => { remoteControlEnabled: boolean })().remoteControlEnabled).toBe(false);

    stopProviderShareCrossRegion();
    expect(state.clients[0].stopped).toBe(true);
    expect(getCrossRegionReceived()).toEqual([]);
  });

  it('forgets the region once the peer reports no shares', async () => {
    state.responses.set('/requests', { requestId: 'r1', status: 'pending', pairingCode: '0042', expiresAt: new Date().toISOString(), requestToken: TOKEN });
    await crossRegionSendRequest('global', TOKEN);
    state.responses.set('/session', { credential: null, expiresAt: null, deviceId: 'x:cn:abc', shares: [] });
    const changed = vi.fn();
    startProviderShareCrossRegion({ changed }, { userDataDir: dir });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await vi.waitFor(() => expect(__testing.readMarkers()).toEqual({}));
    expect(state.clients).toHaveLength(0);
  });
});
