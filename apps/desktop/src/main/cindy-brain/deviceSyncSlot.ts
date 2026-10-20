import { PLUGIN_SYNC_MAX_BYTES } from '@cindy/device-link';
export { PLUGIN_SYNC_CHANNEL } from '@cindy/device-link';
import { randomUUID } from 'node:crypto';
import type { InstalledGhost } from '../../shared/ghost.js';
import { ghostInstallApprovalToken } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import {
  encryptContactsSyncBytes,
  decryptContactsSyncBytes,
  isValidContactsSyncPublicKey,
} from '../contacts-sync/crypto.js';
import type { ContactsSyncKeyStore } from '../contacts-sync/keyStore.js';

/** Opaque, bounded RPC between the same plugin on authenticated owner desktops.
 * Persistence, merge rules and retry idempotency belong to the plugin. No model runs.
 * Transport/key dependencies are injected so account and revocation races are testable.
 */
const MAX_BYTES = PLUGIN_SYNC_MAX_BYTES;
const TIMEOUT_MS = 30_000;
type Identity = { namespace: string | null; id: string };
type Packet = {
  version: 1;
  kind: 'request' | 'response';
  id: string;
  plugin: Identity;
  data: unknown;
};
export interface PluginSyncTransport {
  self(): string | null;
  peers(): Array<{ deviceId: string; deviceName: string }>;
  allowed(peer: string): boolean;
  send(peer: string, frame: unknown): void;
}
interface Deps {
  scope(): string;
  keys: Pick<
    ContactsSyncKeyStore,
    'prepare' | 'getIdentity' | 'getPeerPublicKey' | 'pinPeerPublicKey'
  >;
  getGhost(id: string): InstalledGhost | null;
  listGhosts(): InstalledGhost[];
  deliver(ghost: InstalledGhost, message: unknown, isCurrent: () => boolean): Promise<boolean>;
}
type Pending = {
  peer: string;
  plugin: Identity;
  instance: string;
  current(): boolean;
  finish(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};
type Incoming = {
  peer: string;
  packet: Packet;
  instance: string;
  current(): boolean;
  timer: ReturnType<typeof setTimeout>;
};
const error = (code: string) => ({ ok: false, errorCode: code });
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: Identity, b: Identity) => a.id === b.id && a.namespace === b.namespace;
function identity(ghost: InstalledGhost | null): Identity | null {
  if (
    !ghost?.enabled ||
    ghost.approval.state !== 'approved' ||
    ghost.manifest.deviceSync !== true ||
    ghost.namespaceState !== 'confirmed' ||
    ghost.namespace === undefined
  )
    return null;
  return { id: ghost.manifest.id, namespace: ghost.namespace };
}

export class PluginDeviceSync {
  private transport: PluginSyncTransport | null = null;
  private active = false;
  private generation = 0;
  private scope = '';
  private readonly pending = new Map<string, Pending>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly keyReplies = new Map<string, number>();
  private readonly receiving = new Set<string>();
  private readonly epochs = new Map<string, number>();
  constructor(private readonly deps: Deps) {}
  connect(transport: PluginSyncTransport): void {
    this.reset();
    this.transport = transport;
  }
  setActive(active: boolean): void {
    if (!active) this.reset();
    this.active = active;
  }
  reset(): void {
    this.generation++;
    this.active = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.finish(error('SYNC_RESULT_UNKNOWN'));
    }
    for (const p of this.incoming.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.incoming.clear();
    this.keyReplies.clear();
    this.receiving.clear();
    this.scope = this.deps.scope();
  }
  invalidate(instance: string): void {
    this.epochs.set(instance, (this.epochs.get(instance) ?? 0) + 1);
    for (const [id, p] of this.pending)
      if (p.instance === instance) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.finish(error('SYNC_RESULT_UNKNOWN'));
      }
    for (const [id, p] of this.incoming)
      if (p.instance === instance) {
        clearTimeout(p.timer);
        this.incoming.delete(id);
      }
  }
  private capture(instance: string): (() => boolean) | null {
    const ghost = this.deps.getGhost(instance);
    if (!identity(ghost)) return null;
    const epoch = this.epochs.get(instance) ?? 0;
    const plugin = identity(ghost)!;
    const approval = ghostInstallApprovalToken(ghost!.approval);
    const scope = this.deps.scope(),
      generation = this.generation;
    return () => {
      const current = this.deps.getGhost(instance);
      return (
        this.active &&
        generation === this.generation &&
        epoch === (this.epochs.get(instance) ?? 0) &&
        scope === this.deps.scope() &&
        !!identity(current) &&
        same(identity(current)!, plugin) &&
        ghostInstallApprovalToken(current!.approval) === approval
      );
    };
  }
  async handle(instance: string, raw: unknown): Promise<unknown> {
    if (this.scope !== this.deps.scope()) this.reset();
    const plugin = identity(this.deps.getGhost(instance));
    if (!plugin) return error('SYNC_NOT_ALLOWED');
    if (!record(raw)) return error('INVALID_PARAMS');
    if (raw.op === 'status')
      return {
        ok: true,
        version: 1,
        online: this.active,
        peers: this.active ? (this.transport?.peers() ?? []) : [],
        maxBytes: MAX_BYTES,
      };
    if (raw.op === 'reply') {
      const p = typeof raw.requestId === 'string' ? this.incoming.get(raw.requestId) : null;
      if (!p || p.instance !== instance) return error('SYNC_REQUEST_EXPIRED');
      this.incoming.delete(raw.requestId as string);
      clearTimeout(p.timer);
      if (!p.current() || !this.transport?.allowed(p.peer)) return error('SYNC_REQUEST_EXPIRED');
      try {
        this.send(p.peer, { ...p.packet, kind: 'response', data: raw.data });
        return { ok: true };
      } catch {
        return error('SYNC_RESULT_UNKNOWN');
      }
    }
    if (raw.op !== 'request' || typeof raw.peer !== 'string') return error('INVALID_PARAMS');
    const current = this.capture(instance),
      peer = raw.peer;
    if (!current?.() || !this.transport?.allowed(peer)) return error('SYNC_OFFLINE');
    if (
      this.pending.size >= 32 ||
      [...this.pending.values()].filter((p) => p.instance === instance).length >= 2
    )
      return error('SYNC_BUSY');
    try {
      await this.deps.keys.prepare();
      if (!current() || !this.transport?.allowed(peer)) return error('SYNC_OFFLINE');
      if (
        this.pending.size >= 32 ||
        [...this.pending.values()].filter((p) => p.instance === instance).length >= 2
      )
        return error('SYNC_BUSY');
      if (!this.deps.keys.getPeerPublicKey(peer)) {
        this.transport.send(peer, {
          version: 1,
          kind: 'key',
          publicKey: this.deps.keys.getIdentity().publicKey,
        });
        return error('SYNC_CONNECTING');
      }
      const id = randomUUID();
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(error('SYNC_RESULT_UNKNOWN'));
        }, TIMEOUT_MS);
        timer.unref?.();
        this.pending.set(id, { peer, plugin, instance, current, finish: resolve, timer });
        try {
          this.send(peer, { version: 1, kind: 'request', id, plugin, data: raw.data });
        } catch {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(error('SYNC_RESULT_UNKNOWN'));
        }
      });
    } catch {
      return error('SYNC_SECURE_STORAGE_UNAVAILABLE');
    }
  }
  private send(peer: string, packet: Packet): void {
    const self = this.transport?.self(),
      key = this.deps.keys.getPeerPublicKey(peer);
    if (!self || !key || !this.active || !this.transport?.allowed(peer))
      throw new Error('unavailable');
    const bytes = Buffer.from(JSON.stringify(packet));
    if (bytes.length > MAX_BYTES) throw new Error('packet too large');
    // Domain bind this channel in authenticated transferId, separate from legacy contacts packets.
    const transferId = `plugin-sync:${randomUUID()}`;
    const enc = encryptContactsSyncBytes(bytes, this.deps.keys.getIdentity().privateKey, key, {
      srcDeviceId: self,
      dstDeviceId: peer,
      transferId,
      totalChunks: 1,
    });
    this.transport.send(peer, {
      version: 1,
      kind: 'data',
      transferId,
      iv: enc.iv,
      tag: enc.tag,
      data: enc.ciphertext.toString('base64'),
    });
  }
  async receive(peer: string, raw: unknown): Promise<void> {
    if (
      !this.active ||
      !this.transport?.allowed(peer) ||
      this.scope !== this.deps.scope() ||
      !record(raw) ||
      raw.version !== 1
    )
      return;
    if (this.receiving.has(peer) || this.receiving.size >= 32) return;
    const generation = this.generation,
      scope = this.deps.scope();
    const current = () =>
      this.active &&
      generation === this.generation &&
      scope === this.deps.scope() &&
      this.transport?.allowed(peer);
    this.receiving.add(peer);
    try {
      await this.deps.keys.prepare();
      if (!current()) return;
      if (raw.kind === 'key') {
        if (!isValidContactsSyncPublicKey(raw.publicKey)) return;
        await this.deps.keys.pinPeerPublicKey(peer, raw.publicKey);
        if (!current()) return;
        if (Date.now() - (this.keyReplies.get(peer) ?? 0) > 5000) {
          this.keyReplies.set(peer, Date.now());
          this.transport!.send(peer, {
            version: 1,
            kind: 'key',
            publicKey: this.deps.keys.getIdentity().publicKey,
          });
        }
        return;
      }
      const self = this.transport?.self(),
        key = this.deps.keys.getPeerPublicKey(peer);
      if (
        raw.kind !== 'data' ||
        !self ||
        !key ||
        typeof raw.transferId !== 'string' ||
        !/^plugin-sync:[a-f0-9-]{36}$/.test(raw.transferId) ||
        typeof raw.data !== 'string' ||
        raw.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
        typeof raw.iv !== 'string' ||
        typeof raw.tag !== 'string'
      )
        return;
      const bytes = decryptContactsSyncBytes(
        { ciphertext: Buffer.from(raw.data, 'base64'), iv: raw.iv, tag: raw.tag },
        this.deps.keys.getIdentity().privateKey,
        key,
        { srcDeviceId: peer, dstDeviceId: self, transferId: raw.transferId, totalChunks: 1 },
      );
      const p: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !record(p) ||
        p.version !== 1 ||
        typeof p.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(p.id) ||
        !record(p.plugin) ||
        typeof p.plugin.id !== 'string' ||
        !(p.plugin.namespace === null || typeof p.plugin.namespace === 'string')
      )
        return;
      const packet = p as unknown as Packet;
      if (p.kind === 'response') {
        const pending = this.pending.get(p.id);
        if (
          !pending ||
          pending.peer !== peer ||
          !same(pending.plugin, packet.plugin) ||
          !pending.current()
        )
          return;
        this.pending.delete(p.id);
        clearTimeout(pending.timer);
        pending.finish({ ok: true, data: p.data });
      } else if (p.kind === 'request' && this.incoming.size < 32) {
        const ghost = this.deps.listGhosts().find((g) => {
          const i = identity(g);
          return i && same(i, packet.plugin);
        });
        if (!ghost) return;
        const instance = installedGhostStoragePart(ghost),
          valid = this.capture(instance);
        if (!valid?.()) return;
        const requestId = randomUUID();
        const timer = setTimeout(() => this.incoming.delete(requestId), TIMEOUT_MS);
        timer.unref?.();
        this.incoming.set(requestId, { peer, packet, instance, current: valid, timer });
        if (
          !(await this.deps.deliver(
            ghost,
            {
              type: 'device-sync-request',
              requestId,
              peer,
              data: p.data,
            },
            valid,
          )) ||
          !valid()
        ) {
          clearTimeout(timer);
          this.incoming.delete(requestId);
        }
      }
    } catch {
      /* Invalid/unauthenticated frames never surface their contents or mutate plugin data. */
    } finally {
      if (generation === this.generation) this.receiving.delete(peer);
    }
  }
}
