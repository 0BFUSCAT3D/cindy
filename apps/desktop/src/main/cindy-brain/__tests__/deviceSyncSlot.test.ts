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
    const keys = {
      prepare: vi.fn(async () => {}),
      getIdentity: () => identity,
      getPeerPublicKey: (p: string) => pins.get(p) ?? null,
      pinPeerPublicKey: async (p: string, k: string) => {
        if (pins.has(p) && pins.get(p) !== k) throw Error('pin');
        const fresh = !pins.has(p);
        pins.set(p, k);
        return fresh;
      },
    };
    const deliver = vi.fn(async (_ghost: InstalledGhost, msg: unknown, valid: () => boolean) => {
      if (!valid()) return false;
      delivered.push(msg);
      return true;
    });
    const other = { ...g, manifest: { ...manifest, id: 'other-sync' }, instanceKey: 'other-sync' } as InstalledGhost;
    const ghosts = [g, other];
    const svc = new PluginDeviceSync({
      scope: () => scope,
      keys,
      getGhost: (key) => ghosts.find(ghost => ghost.instanceKey === key) ?? null,
      listGhosts: () => ghosts,
      deliver,
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
      keys,
      deliver,
      addPlugin: (id: string) => ghosts.push({ ...g, manifest: { ...manifest, id }, instanceKey: id } as InstalledGhost),
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
  return { a, b, frames, flush, ready, addPeer: (id: string) => { const peer = side(id); sides.set(id, peer); return peer; } };
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

// PR #6569: the wire callback does not await receive. Sequential flush alone missed
// same-peer overlap and revocation while the runtime was starting (unit tier).
it('queues concurrent same-peer frames across plugins while key preparation is pending', async () => {
  const { a, b, frames, ready, flush } = pair();
  await ready();
  const requests = ['example-sync', 'example-sync', 'other-sync'].map((plugin, n) =>
    a.svc.handle(plugin, { op: 'request', peer: 'b', data: { n } }));
  await Promise.resolve(); await Promise.resolve();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  b.keys.prepare.mockImplementationOnce(() => blocked);
  const receiving = frames.splice(0).map(f => b.svc.receive(f.from, f.data));
  expect(receiving).toHaveLength(3);
  expect(b.delivered).toHaveLength(0);
  release(); await Promise.all(receiving);
  expect(b.delivered.map(m => m.data.n)).toEqual([0, 1, 2]);
  for (const msg of b.delivered) await b.svc.handle(msg.data.n === 2 ? 'other-sync' : 'example-sync', {
    op: 'reply', requestId: msg.requestId, data: { persisted: msg.data.n },
  });
  await flush();
  expect(await Promise.all(requests)).toEqual([0, 1, 2].map(n => ({ ok: true, data: { persisted: n } })));
});

it('rechecks device revocation after waiting for plugin startup and before delivery', async () => {
  const { a, b, frames, ready } = pair(); await ready();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const loading = new Promise<void>(resolve => { release = resolve; });
  b.deliver.mockImplementation(async (_ghost, msg, valid) => {
    entered(); await loading;
    if (!valid()) return false;
    b.delivered.push(msg); return true;
  });
  const result = a.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve(); await Promise.resolve();
  const frame = frames.shift()!;
  const receiving = b.svc.receive(frame.from, frame.data);
  await started; b.blocked.add('a'); release(); await receiving;
  expect(b.delivered).toHaveLength(0);
  a.svc.reset(); expect(await result).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
});


it('keeps another peer flowing while a receive queue waits and discards queued frames on reset', async () => {
  const { a, b, frames, ready, flush, addPeer } = pair(); await ready();
  const c = addPeer('c');
  expect(await c.svc.handle('example-sync', { op: 'request', peer: 'b', data: {} })).toMatchObject({ errorCode: 'SYNC_CONNECTING' });
  await flush();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const loading = new Promise<void>(resolve => { release = resolve; });
  b.keys.prepare.mockImplementationOnce(() => { entered(); return loading; });
  const pending = [0, 1].map(n => a.svc.handle('example-sync', { op: 'request', peer: 'b', data: { n } }));
  await Promise.resolve(); await Promise.resolve();
  const receiving = frames.splice(0).map(f => b.svc.receive(f.from, f.data));
  await started;
  const other = c.svc.handle('example-sync', { op: 'request', peer: 'b', data: { other: true } });
  await Promise.resolve(); await Promise.resolve(); await flush();
  expect(b.delivered.map(m => m.data)).toEqual([{ other: true }]);
  await b.svc.handle('example-sync', { op: 'reply', requestId: b.delivered[0].requestId, data: { persisted: true } });
  await flush(); expect(await other).toEqual({ ok: true, data: { persisted: true } });
  b.svc.reset(); b.svc.setActive(true); release(); await Promise.all(receiving);
  expect(b.delivered).toHaveLength(1);
  a.svc.reset();
  expect(await Promise.all(pending)).toEqual([0, 1].map(() => ({ ok: false, errorCode: 'SYNC_RESULT_UNKNOWN' })));
});


it('reactivates under the new owner when account commit follows teardown', async () => {
  const { b } = pair();
  b.svc.reset(); b.setScope('owner-b'); b.svc.setActive(true);
  expect(await b.svc.handle('example-sync', { op: 'status' })).toMatchObject({ online: true });
});

// The documented concurrency budget counts incoming and outgoing requests together.
it.each([2, 32])('counts incoming requests toward the combined %i request budget', async count => {
  const { a, b, ready, flush, addPeer } = pair(); await ready();
  const c = addPeer('c'); c.addPlugin('budget-0');
  expect(await c.svc.handle('budget-0', { op: 'request', peer: 'b', data: {} })).toMatchObject({ errorCode: 'SYNC_CONNECTING' });
  await flush();
  const requests: Array<Promise<unknown>> = [];
  for (let i = 0; i < count / 2; i++) {
    const id = `budget-${i}`; a.addPlugin(id); b.addPlugin(id);
    for (let n = 0; n < 2; n++) requests.push(a.svc.handle(id, { op: 'request', peer: 'b', data: { n } }));
  }
  await Promise.resolve(); await Promise.resolve(); await flush();
  expect(b.delivered).toHaveLength(count);
  const extra = c.svc.handle('budget-0', { op: 'request', peer: 'b', data: {} });
  await Promise.resolve(); await Promise.resolve(); await flush();
  expect(b.delivered).toHaveLength(count);
  // Per-plugin limit with spare global slots, or global limit for a different plugin.
  const outbound = b.svc.handle(count === 2 ? 'budget-0' : 'example-sync', { op: 'request', peer: 'a', data: {} });
  await vi.advanceTimersByTimeAsync(30001);
  expect(await outbound).toMatchObject({ errorCode: 'SYNC_BUSY' });
  expect(await extra).toMatchObject({ errorCode: 'SYNC_RESULT_UNKNOWN' });
  expect(await Promise.all(requests)).toEqual(Array.from({ length: count }, () => ({ ok: false, errorCode: 'SYNC_RESULT_UNKNOWN' })));
});
