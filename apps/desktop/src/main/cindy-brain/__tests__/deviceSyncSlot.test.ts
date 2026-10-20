import { afterEach, expect, it, vi } from 'vitest';
import { PluginDeviceSync } from '../deviceSyncSlot.js';
import { generateContactsSyncIdentity } from '../../contacts-sync/crypto.js';
import {
  ghostPermissionItems,
  validateGhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import { validateGhostManifest as validateProtocolManifest } from '../../../../../../packages/plugin-protocol/src/manifest.js';

// New generic plugin boundary: real handler/encryption, in-memory wire. Unit tier.
// Existing contacts tests cannot cover plugin namespace, owner/revision and permission isolation.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.useRealTimers();
});
const manifest = {
  schemaVersion: 3,
  id: 'example-sync',
  name: 'Example',
  version: '1.0.0',
  minCindyVersion: '0.1.97',
  entry: 'main.js',
  deviceSync: true,
};
function pair() {
  vi.useFakeTimers();
  const frames: Array<{ from: string; to: string; data: unknown }> = [];
  const sides = new Map<string, ReturnType<typeof side>>();
  function side(id: string) {
    let scope = 'owner-a';
    const g = {
      manifest,
      enabled: true,
      namespace: null,
      namespaceState: 'confirmed',
      instanceKey: 'example-sync',
      approval: { state: 'approved', revision: '1' },
    } as InstalledGhost;
    const identity = generateContactsSyncIdentity(),
      pins = new Map<string, string>(),
      delivered: any[] = [];
    const blocked = new Set<string>();
    const svc = new PluginDeviceSync({
      scope: () => scope,
      keys: {
        prepare: async () => {},
        getIdentity: () => identity,
        getPeerPublicKey: (p) => pins.get(p) ?? null,
        pinPeerPublicKey: async (p, k) => {
          if (pins.has(p) && pins.get(p) !== k) throw Error('pin');
          const fresh = !pins.has(p);
          pins.set(p, k);
          return fresh;
        },
      },
      getGhost: (key) => (key === 'example-sync' ? g : null),
      listGhosts: () => [g],
      deliver: async (_ghost, msg) => {
        delivered.push(msg);
        return true;
      },
    });
    svc.connect({
      self: () => id,
      peers: () =>
        [...sides.keys()]
          .filter((x) => x !== id)
          .map((deviceId) => ({ deviceId, deviceName: deviceId })),
      allowed: (peer) => sides.has(peer) && peer !== id && !blocked.has(peer),
      send: (to, data) => {
        frames.push({ from: id, to, data });
      },
    });
    svc.setActive(true);
    cleanups.push(() => svc.reset());
    return {
      svc,
      g,
      delivered,
      blocked,
      setScope: (v: string) => {
        scope = v;
      },
    };
  }
  const a = side('a');
  sides.set('a', a);
  const b = side('b');
  sides.set('b', b);
  async function flush() {
    while (frames.length) {
      const f = frames.shift()!;
      await sides.get(f.to)!.svc.receive(f.from, f.data);
    }
  }
  async function ready() {
    expect(
      await a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} }),
    ).toMatchObject({ errorCode: 'SYNC_CONNECTING' });
    await flush();
  }
  return { a, b, frames, flush, ready };
}
it('declares the capability without changing legacy manifests and projects its permission', () => {
  for (const validate of [validateGhostManifest, validateProtocolManifest]) {
    expect(validate(manifest), JSON.stringify(validate(manifest))).toMatchObject({
      ok: true,
      manifest: { deviceSync: true },
    });
    expect(validate({ ...manifest, deviceSync: false }).ok).toBe(false);
  }
  expect(ghostPermissionItems(manifest as any)).toContainEqual(
    expect.objectContaining({ key: 'deviceSync' }),
  );
});
it('exchanges encrypted opaque data only with the same plugin, then confirms the reply', async () => {
  const { a, b, frames, flush, ready } = pair();
  await ready();
  const result = a.svc.handle('example-sync', {
    op: 'request',
    peer: 'b',
    data: { text: 'private example' },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.stringify(frames)).not.toContain('private example');
  await flush();
  expect(b.delivered).toHaveLength(1);
  expect(b.delivered[0].data).toEqual({ text: 'private example' });
  expect(
    await b.svc.handle('example-sync', {
      op: 'reply',
      requestId: b.delivered[0].requestId,
      data: { persisted: true },
    }),
  ).toEqual({ ok: true });
  await flush();
  expect(await result).toEqual({ ok: true, data: { persisted: true } });
});
it('does not deliver across namespaces, revocation, disable or owner switches', async () => {
  const { a, b, flush, ready } = pair();
  await ready();
  b.g.namespace = 'example-org';
  const request = a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve();
  await Promise.resolve();
  await flush();
  expect(b.delivered).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30001);
  expect(await request).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
  b.g.namespace = null;
  b.blocked.add('a');
  const second = a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve();
  await Promise.resolve();
  await flush();
  expect(b.delivered).toHaveLength(0);
  a.svc.reset();
  expect(await second).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
  b.g.enabled = false;
  expect(await b.svc.handle('example-sync', { op: 'status' })).toMatchObject({
    errorCode: 'SYNC_NOT_ALLOWED',
  });
  b.g.enabled = true;
  b.setScope('owner-b');
  expect(await b.svc.handle('example-sync', { op: 'status' })).toMatchObject({ online: false });
});
it('invalidates replies after plugin replacement and rejects ciphertext tampering', async () => {
  const { a, b, frames, flush, ready } = pair();
  await ready();
  const result = a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve();
  await Promise.resolve();
  const f = structuredClone(frames[0]);
  (f.data as any).tag = 'AAAAAAAAAAAAAAAAAAAAAA==';
  await b.svc.receive('a', f.data);
  expect(b.delivered).toHaveLength(0);
  await flush();
  expect(b.delivered).toHaveLength(1);
  b.g.approval = { state: 'approved', revision: '2' };
  expect(
    await b.svc.handle('example-sync', {
      op: 'reply',
      requestId: b.delivered[0].requestId,
      data: {},
    }),
  ).toMatchObject({ errorCode: 'SYNC_REQUEST_EXPIRED' });
  a.svc.reset();
  expect(await result).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
});

it('expires in-flight work on stop even when the same install immediately restarts', async () => {
  const { a, b, flush, ready } = pair();
  await ready();
  const result = a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve();
  await Promise.resolve();
  await flush();
  expect(b.delivered).toHaveLength(1);
  b.svc.invalidate('example-sync');
  expect(
    await b.svc.handle('example-sync', {
      op: 'reply',
      requestId: b.delivered[0].requestId,
      data: {},
    }),
  ).toMatchObject({ errorCode: 'SYNC_REQUEST_EXPIRED' });
  a.svc.invalidate('example-sync');
  expect(await result).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
  expect(await a.svc.handle('example-sync', { op: 'status' })).toMatchObject({ online: true });
});
