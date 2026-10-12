// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderShareReceivedSnapshot } from '../../shared/providerShare';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetForTest, addModelFavorite, listModelFavorites, setModelFavoritesOwner } from '@/state/modelFavorites';
import { providerShareFavoriteSource } from '@/state/providerShareFavorites';
import { ensureProviderShareReceivedStarted, resetProviderShareStoreForTests } from '@/features/provider-share/providerShareStore';

vi.mock('@/hooks/useDeviceProviders', () => ({ getCachedDeviceProviders: () => null }));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: vi.fn(async () => {}) }));
const share: ProviderShareReceived = {
  shareId: 's1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host',
  deviceName: 'Host', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true,
};
let push: (list: ProviderShareReceived[]) => void;
let snapshot: ProviderShareReceivedSnapshot;
let readSnapshot: () => Promise<ProviderShareReceivedSnapshot>;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  resetProviderShareStoreForTests();
  __resetForTest();
  window.localStorage.clear();
  setDataOwnerGeneration('recipient', 1);
  setModelFavoritesOwner('recipient');
  snapshot = { ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 1 }, confirmedRegions: [], received: [] };
  readSnapshot = async () => snapshot;
  Object.assign(window, { electronAPI: { providerShare: {
    command: (command: { action: string }) => command.action === 'received-snapshot' ? readSnapshot() : Promise.resolve(snapshot.received),
    onReceivedChanged: (listener: typeof push) => { push = listener; return () => {}; },
  } } });
  addModelFavorite({ providerId: providerShareFavoriteSource(share), modelId: 'opus', agent: 'cc' });
});
afterEach(() => { resetProviderShareStoreForTests(); vi.restoreAllMocks(); });

it('cleans favorites without opening a picker, only after Main confirms the last share was removed', async () => {
  ensureProviderShareReceivedStarted();
  await tick();
  expect(listModelFavorites()).toHaveLength(1);
  push([]); // 断线时的空推送。
  await tick();
  expect(listModelFavorites()).toHaveLength(1);
  snapshot = { ...snapshot, confirmedRegions: ['global'], received: [{ ...share, status: 'paused', hostOnline: false }] };
  push([...snapshot.received]);
  await tick();
  expect(listModelFavorites()).toHaveLength(1);
  snapshot = { ...snapshot, received: [] };
  push([]);
  await tick();
  expect(listModelFavorites()).toEqual([]);
});

it('does not apply a superseded membership reply or an earlier account response', async () => {
  let finish!: (snapshot: ProviderShareReceivedSnapshot) => void;
  readSnapshot = () => new Promise((resolve) => { finish = resolve; });
  ensureProviderShareReceivedStarted();
  await tick();
  const stale = finish;
  readSnapshot = async () => ({ ...snapshot, confirmedRegions: ['global'], received: [share] });
  push([share]);
  await tick();
  stale({ ...snapshot, confirmedRegions: ['global'], received: [] });
  await tick();
  expect(listModelFavorites()).toHaveLength(1);
  readSnapshot = () => new Promise((resolve) => { finish = resolve; });
  push([]);
  setDataOwnerGeneration('other', 2);
  setModelFavoritesOwner('other');
  addModelFavorite({ providerId: providerShareFavoriteSource(share), modelId: 'opus', agent: 'cc' });
  finish({ ...snapshot, confirmedRegions: ['global'], received: [] });
  await tick();
  expect(listModelFavorites()).toHaveLength(1);
});
