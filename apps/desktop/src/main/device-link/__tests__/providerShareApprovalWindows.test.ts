import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ scope: 'owner-a', boundaryPending: false, owned: [] as unknown[] }));
vi.mock('../../appSessionState.js', () => ({ isAppSessionBoundaryPending: () => state.boundaryPending }));
vi.mock('../../authManager.js', () => ({ getAuthState: () => ({ isAuthenticated: true }), getDeviceId: () => 'host-device' }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: () => true }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true }) }));
vi.mock('../providerShareApi.js', () => ({
  providerShareOwnerKey: () => state.scope,
  providerShareApi: { listOwned: async () => state.owned },
}));

type Host = typeof import('../providerShareHost');
let dir: string;
let host: Host;
let windows: typeof import('../providerShareApprovalWindows');
const events = () => ({ changed: vi.fn(), requested: vi.fn(), watchedRequested: vi.fn(), revoked: vi.fn(), reconcile: vi.fn() });
const request = { requestId: 'request-1', displayName: 'Guest', avatarUrl: null, region: 'global' as const,
  pairingCode: '0123', createdAt: '2026-10-15T08:00:00Z', expiresAt: '2026-10-16T08:00:00Z' };
const ownedShare = { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host-device',
  createdAt: '2026-10-15T08:00:00Z', members: [], requests: [request] };
const filePath = () => path.join(dir, state.scope, 'provider-share-approval-windows.json');
const assertCurrent = () => { if (state.boundaryPending) throw new Error('account boundary'); };

async function loadProcess() {
  vi.resetModules();
  windows = await import('../providerShareApprovalWindows');
  windows.configureProviderShareApprovalWindows({ filePath, scopeKey: () => state.scope });
  host = await import('../providerShareHost');
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-approval-window-'));
  state.scope = 'owner-a';
  state.boundaryPending = false;
  state.owned = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T08:00:00Z'));
  await loadProcess();
});

afterEach(() => {
  host.stopProviderShareHost();
  windows.configureProviderShareApprovalWindows(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('approval ownership across a complete application restart', () => {
  it('keeps the supplier computer quiet before its first snapshot after restart', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    await loadProcess(); // 丢掉模块内存，模拟完整 Electron 主进程重启。
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('restart');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), true);
  });

  it('rebuilds the generating computer reader and continues polling after restart', async () => {
    host.startProviderShareHost(events());
    await host.watchProviderShareRequests('group-host', 'anthropic', async () => []);
    host.stopProviderShareHost();
    await loadProcess();
    const readWatchedShares = vi.fn(async () => [{ ...ownedShare, hostDeviceId: 'group-host' }]);
    const ev = events();
    host.startProviderShareHost(ev, { readWatchedShares });
    await host.refreshProviderShareHost('restart');
    expect(readWatchedShares).toHaveBeenCalledWith('group-host');
    expect(ev.watchedRequested).toHaveBeenCalledWith(expect.objectContaining({ request, hostDeviceId: 'group-host' }));
    expect(host.getProviderShareHostSnapshot()).toEqual([]);
  });

  it('does not restore an expired quiet window', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    vi.setSystemTime(Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS + 1);
    await loadProcess();
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('expired');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), false);
  });

  it('persists a local link clearing the previous quiet window', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    await host.clearProviderShareRequestQuiet('anthropic');
    host.stopProviderShareHost();
    await loadProcess();
    state.owned = [ownedShare];
    const ev = events();
    host.startProviderShareHost(ev);
    await host.refreshProviderShareHost('local-link');
    expect(ev.requested).toHaveBeenCalledWith(request, expect.anything(), false);
  });

  it('does not read another account ownership and restores it after switching back', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    host.stopProviderShareHost();
    await loadProcess();
    state.scope = 'owner-b';
    state.owned = [ownedShare];
    const other = events();
    host.startProviderShareHost(other);
    await host.refreshProviderShareHost('other-account');
    expect(other.requested).toHaveBeenCalledWith(request, expect.anything(), false);
    host.stopProviderShareHost();
    state.scope = 'owner-a';
    const original = events();
    host.startProviderShareHost(original);
    await host.refreshProviderShareHost('original-account');
    expect(original.requested).toHaveBeenCalledWith(request, expect.anything(), true);
  });
});

describe('approval ownership storage', () => {
  it('keeps both sides of concurrently saved windows without storing link or person details', async () => {
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    await Promise.all([
      windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { ...current.quietUntil, anthropic: until } }), assertCurrent),
      windows.updateProviderShareApprovalWindows((current) => ({ ...current, watches: [{ hostDeviceId: 'group-host', providerId: 'openai', until }] }), assertCurrent),
    ]);
    const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(stored).toEqual({ quietUntil: { anthropic: until }, watches: [{ hostDeviceId: 'group-host', providerId: 'openai', until }] });
  });

  it('preserves a corrupt file instead of overwriting it', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{broken');
    await expect(windows.updateProviderShareApprovalWindows((current) => current, assertCurrent)).rejects.toThrow();
    expect(fs.readFileSync(filePath(), 'utf8')).toBe('{broken');
  });

  it('rejects a save at an account boundary without creating a file', async () => {
    state.boundaryPending = true;
    await expect(windows.updateProviderShareApprovalWindows((current) => current, assertCurrent)).rejects.toThrow('account boundary');
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('does not commit to either account after switching while waiting for the lock', async () => {
    const originalFile = filePath();
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    const save = windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { anthropic: until } }), assertCurrent);
    state.scope = 'owner-b';
    await expect(save).rejects.toThrow('Could not save provider share approval ownership');
    expect(fs.existsSync(originalFile)).toBe(false);
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('retains the previous disk state when atomic replacement fails', async () => {
    const until = Date.now() + windows.PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS;
    await windows.updateProviderShareApprovalWindows((current) => ({ ...current, quietUntil: { anthropic: until } }), assertCurrent);
    const original = fs.readFileSync(filePath(), 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === filePath()) throw Object.assign(new Error('disk write failed'), { code: 'EIO' });
      return rename(source, target);
    });
    await expect(windows.updateProviderShareApprovalWindows((current) => ({
      ...current, quietUntil: { ...current.quietUntil, openai: until },
    }), assertCurrent)).rejects.toThrow('Could not save provider share approval ownership');
    expect(fs.readFileSync(filePath(), 'utf8')).toBe(original);
  });

  it('keeps the active quiet window when clearing it fails to persist', async () => {
    host.startProviderShareHost(events());
    await host.quietProviderShareRequests('anthropic');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === filePath()) throw Object.assign(new Error('private path must not escape'), { code: 'EIO' });
      return rename(source, target);
    });
    await expect(host.clearProviderShareRequestQuiet('anthropic')).rejects.toThrow('Could not save provider share approval ownership');
    state.owned = [ownedShare];
    await host.refreshProviderShareHost('save-failed');
    expect(host.getProviderShareQuietRequestIds()).toEqual(['request-1']);
  });
});
