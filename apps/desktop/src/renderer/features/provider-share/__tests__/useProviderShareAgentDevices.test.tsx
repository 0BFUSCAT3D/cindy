// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';
import { PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import { resetProviderShareStoreForTests } from '../providerShareStore';
import { useProviderShareAgentDevices } from '../useProviderShareAgentDevices';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; index?: number }) =>
      key === 'providerShare.received.fromOwner'
        ? `from ${options?.name}`
        : key === 'providerShare.picker.numbered'
          ? `${options?.name} (${options?.index})`
          : key,
  }),
}));

const catalog = vi.hoisted(() => ({
  refresh: vi.fn<(deviceId: string) => Promise<void>>(async () => undefined),
  cached: new Set<string>(),
}));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: catalog.refresh }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  getCachedDeviceProviders: (deviceId: string) => (catalog.cached.has(deviceId) ? { providers: [] } : null),
}));

function share(partial: Partial<ProviderShareReceived>): ProviderShareReceived {
  return {
    shareId: 's1',
    memberId: 'm1',
    providerId: 'xd',
    providerLabel: 'Cindy AI',
    hostDeviceId: 'host-1',
    deviceName: "Magi's Mac Mini",
    owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
    status: 'active',
    hostOnline: true,
    hostCapable: true,
    ...partial,
  };
}

let push: ((list: ProviderShareReceived[]) => void) | null = null;
let initial: ProviderShareReceived[] = [];
let linkStatus: ((payload: { status: 'online' | 'connecting' | 'stopped' }) => void) | null = null;
const invoke = vi.fn();

function hostShares(...entries: Array<{ shareId: string; status?: 'active' | 'paused' }>) {
  return { shares: entries.map((entry) => ({
    ...share(entry), agentDeviceId: `share:${entry.shareId}`, catalog: null,
  })) };
}

beforeEach(() => {
  resetProviderShareStoreForTests();
  catalog.refresh.mockClear();
  catalog.cached.clear();
  push = null;
  initial = [];
  linkStatus = null;
  invoke.mockReset().mockResolvedValue(hostShares());
  setDataOwnerGeneration('owner', 1);
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        invoke,
        onStatusChanged: (callback: typeof linkStatus) => {
          linkStatus = callback;
          return () => { linkStatus = null; };
        },
      },
      providerShare: {
        command: vi.fn(async () => initial),
        onReceivedChanged: (cb: (list: ProviderShareReceived[]) => void) => {
          push = cb;
          return () => undefined;
        },
      },
    },
  });
});

afterEach(() => cleanup());

describe('useProviderShareAgentDevices', () => {
  it('only offers new shares that the controlled host has loaded, even if the controller has more cross-region shares', async () => {
    initial = [share({ shareId: 'both' }), share({ shareId: 'controller-only' })];
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }, { shareId: 'host-only' }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:both']));
    expect(invoke).toHaveBeenCalledWith('host-b', PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, [
      { includeCatalog: false },
    ]);
    // host 的目录暂时读不到(catalog: null)不等于 host 没有加载分享；目录仍走既有分享读取。
    expect(result.current.isReceived('share:controller-only')).toBe(true);
  });

  it('keeps current/pending shares while excluding new shares paused or unknown on the controlled host', async () => {
    initial = ['current', 'pending', 'paused', 'unknown'].map((shareId) => share({ shareId }));
    invoke.mockResolvedValue(hostShares({ shareId: 'paused', status: 'paused' }));
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:current', 'share:pending'], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(['share:current', 'share:pending']);
  });

  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_NOT_CONNECTED'])('does not fall back to controller shares after %s; retries on focus', async (code) => {
    initial = [share({ shareId: 'both' })];
    invoke.mockRejectedValueOnce(new Error(`[${code}] host unavailable`));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    invoke.mockResolvedValue(hostShares());
    act(() => push?.([...initial]));
    await waitFor(() => expect(result.current.devices).toEqual([]));
  });

  it('does not use another host’s result or a late disconnected response', async () => {
    initial = [share({ shareId: 'both' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ host }) => useProviderShareAgentDevices([], host), { initialProps: { host: 'host-b' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ host: 'host-c' });
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => linkStatus?.({ status: 'stopped' }));
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
    invoke.mockResolvedValue(hostShares({ shareId: 'both' }));
    act(() => linkStatus?.({ status: 'online' }));
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
  });

  it('rejects an in-flight result after an account generation change', async () => {
    initial = [share({ shareId: 'both' })];
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useProviderShareAgentDevices([], 'host-b'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    setDataOwnerGeneration('another-owner', 2);
    await act(async () => finish(hostShares({ shareId: 'both' })));
    expect(result.current.devices).toEqual([]);
  });

  it('names shares by owner only (numbering repeats), never by the sharer’s computer', async () => {
    initial = [
      share({ shareId: 'a' }),
      share({ shareId: 'b', status: 'paused', deviceName: 'Studio' }),
      share({ shareId: 'c', providerLabel: 'Anthropic', deviceName: 'Laptop' }),
    ];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.devices).toEqual([
      { deviceId: 'share:a', name: 'from Magi' },
      { deviceId: 'share:c', name: 'from Magi' },
    ]);
    // 同一位分享者的同一个供应商第二份加序号；暂停的也算在内，序号不因暂停而变。
    expect(result.current.nameFor('share:b')).toBe('from Magi (2)');
    expect(JSON.stringify(result.current.devices)).not.toMatch(/Mac Mini|Studio|Laptop/);
    expect(result.current.nameFor('device-123')).toBeNull();
    expect(result.current.isKnown('share:b')).toBe(true);
    expect(result.current.isKnown('share:zzz')).toBe(false);
    expect(result.current.isReceived('share:b')).toBe(true);
    expect(result.current.isReceived('share:zzz')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the current paused or removed share so the task can see and leave it', async () => {
    initial = [share({ shareId: 'paused', status: 'paused' })];
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:paused', 'share:gone', 'device-1']));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.devices.map((device) => device.deviceId)).toEqual(['share:paused', 'share:gone']);
    expect(result.current.devices[1].name).toBe('providerShare.picker.unavailable');
  });

  it('does not treat the not-yet-loaded list as removed', () => {
    Object.assign(window.electronAPI.providerShare, { command: vi.fn(() => new Promise(() => undefined)) });
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:x']));
    expect(result.current.loaded).toBe(false);
    expect(result.current.isKnown('share:x')).toBe(true);
    expect(result.current.isReceived('share:x')).toBe(false);
    expect(result.current.devices).toEqual([]);
  });

  it('treats the empty list pushed on disconnect as temporarily unknown, not removed', async () => {
    initial = [share({ shareId: 'a' })];
    const { result } = renderHook(() => useProviderShareAgentDevices(['share:a']));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.cached.add('share:a');
    act(() => push?.([]));
    expect(catalog.refresh).not.toHaveBeenCalled();
    expect(result.current.isKnown('share:a')).toBe(true);
  });

  it('refreshes catalogs of shares whose availability changed and of cached removed shares', async () => {
    initial = [share({ shareId: 'a' }), share({ shareId: 'b' }), share({ shareId: 'c' })];
    const { result } = renderHook(() => useProviderShareAgentDevices());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    catalog.cached.add('share:c');
    act(() => push?.([share({ shareId: 'a' }), share({ shareId: 'b', hostOnline: false })]));
    expect(catalog.refresh.mock.calls.map(([deviceId]) => deviceId).sort()).toEqual(['share:b', 'share:c']);
    expect(result.current.devices.map((device) => device.deviceId)).toEqual(['share:a', 'share:b']);
  });
});
