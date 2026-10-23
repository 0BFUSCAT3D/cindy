import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, SHARED_TASK_RELAY_CAPABILITY, type Envelope, type WsLike } from '@cindy/device-link';
import { TerminalDeviceService } from './service.js';
import type { TerminalDeviceServiceOptions, TerminalRemoteContext } from './types.js';

/** Exercises the production client on both ends. Only the authenticated relay
 * is in memory: it assigns source IDs from the socket's authenticated identity. */
class Relay {
  sockets = new Map<string, Socket>();
  frames: Envelope[] = [];
  open(id: string, headers: Record<string, string>): Socket {
    if (headers.authorization !== `Bearer token:${id}`) throw new Error('Bad relay authentication');
    const socket = new Socket(this, id);
    this.sockets.set(id, socket);
    setImmediate(() => socket.emit('open'));
    return socket;
  }
  route(source: Socket, raw: string): void {
    const frame = JSON.parse(raw) as Envelope;
    this.frames.push({ ...frame, src: source.id });
    if (frame.kind === 'hello') {
      source.push({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
        serverProtocolVersion: PROTOCOL_VERSION, deviceId: source.id, userId: 'owner', capabilities: [SHARED_TASK_RELAY_CAPABILITY],
      } });
    } else if (frame.kind === 'ping') {
      source.push({ v: PROTOCOL_VERSION, kind: 'pong', payload: {} });
    } else if (frame.dst) this.sockets.get(frame.dst)?.push({ ...frame, src: source.id });
  }
}
class Socket extends EventEmitter implements WsLike {
  closed = false;
  constructor(private relay: Relay, readonly id: string) { super(); }
  send(raw: string) { if (!this.closed) queueMicrotask(() => this.relay.route(this, raw)); }
  push(frame: Envelope) { if (!this.closed) queueMicrotask(() => this.emit('message', JSON.stringify(frame))); }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    if (this.relay.sockets.get(this.id) === this) this.relay.sockets.delete(this.id);
    this.emit('close', code);
  }
}
const services: TerminalDeviceService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.stop(); });
function make(relay: Relay, id: string, options: Partial<TerminalDeviceServiceOptions> = {}) {
  const service = new TerminalDeviceService({
    getToken: async () => `token:${id}`,
    getOwnerScope: () => 'owner:global:1', getWsUrl: () => 'wss://example.test/api/device-link/ws',
    getHello: () => ({ deviceName: id, platform: 'linux', appVersion: '0.1.0', remoteControlEnabled: true, busy: false }),
    createWebSocket: (_url, headers) => relay.open(id, headers), invokeLocal: async () => null,
    timing: { pingIntervalMs: 60_000, requestTimeoutMs: 1000, reconnectBaseMs: 1, reconnectMaxMs: 5 },
    ...options,
  });
  services.push(service); service.start(); return service;
}
async function online(...all: TerminalDeviceService[]) { await Promise.all(all.map(service => service.client.waitUntilOnline(1000))); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('terminal bidirectional remote service', () => {
  it('executes at the authenticated source, supports mutual control and refcounted subscriptions', async () => {
    const relay = new Relay();
    const pushes = vi.fn();
    const contexts: TerminalRemoteContext[] = [];
    const host = make(relay, 'host', { invokeLocal: async (_channel, args, context) => {
      contexts.push(context); return { controller: context.sourceDeviceId, claimed: args[0] };
    } });
    const controller = make(relay, 'controller', { onPush: pushes, invokeLocal: async () => 'controller-result' });
    await online(host, controller);
    await expect(controller.invoke('host', 'local-db:sessions:list', [{ sourceDeviceId: 'imposter' }]))
      .resolves.toEqual({ controller: 'controller', claimed: { sourceDeviceId: 'imposter' } });
    expect(contexts[0].source).toEqual({ kind: 'owner', peerId: 'controller', deviceId: 'controller' });
    await expect(host.invoke('controller', 'local-db:sessions:list')).resolves.toBe('controller-result');
    const unsubscribe1 = await controller.subscribe('host', ['sessions']);
    const unsubscribe2 = await controller.subscribe('host', ['sessions']);
    await host.publish('local-db:sessions:patched', { sessionId: 's1' });
    await vi.waitFor(() => expect(pushes).toHaveBeenCalledTimes(1), { interval: 1 });
    await unsubscribe1();
    await host.publish('local-db:sessions:patched', { sessionId: 's1' });
    await vi.waitFor(() => expect(pushes).toHaveBeenCalledTimes(2), { interval: 1 });
    await unsubscribe2();
    await host.publish('local-db:sessions:patched', { sessionId: 's1' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(pushes).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown commands and unauthorised scoped callers without executing business code', async () => {
    const relay = new Relay();
    const invokeLocal = vi.fn();
    const host = make(relay, 'host', { invokeLocal });
    const controller = make(relay, 'controller');
    await online(host, controller);
    await expect(controller.invoke('host', 'app:credentials:read')).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    const replies: Envelope[] = [];
    // The relay may legitimately deliver a guest envelope; membership still
    // needs a host authority resolver and may never inherit owner privileges.
    const guestSocket = new Socket(relay, 'guest1');
    guestSocket.on('message', (raw: string) => replies.push(JSON.parse(raw)));
    relay.sockets.set('guest1', guestSocket);
    relay.sockets.get('host')!.push({ v: PROTOCOL_VERSION, kind: 'invoke', src: 'guest1', dst: 'host',
      sharedTask: { sharedTaskId: 'task1', source: { role: 'guest', memberId: 'member1' }, target: { role: 'host' } },
      id: 'guest-request', payload: { channel: 'local-db:sessions:list', args: [] } });
    await vi.waitFor(() => expect(replies.some(frame => frame.kind === 'invoke-result')).toBe(true), { interval: 1 });
    expect(replies.find(frame => frame.kind === 'invoke-result')?.payload).toMatchObject({ ok: false, error: { message: expect.stringContaining('ACCESS_REVOKED') } });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('does not repeat writes when request ids repeat and refuses changed payloads', async () => {
    const relay = new Relay();
    const run = vi.fn(async () => 'saved');
    const host = make(relay, 'host', { invokeLocal: run });
    const controller = make(relay, 'controller');
    await online(host, controller);
    const frame: Envelope = { v: PROTOCOL_VERSION, kind: 'invoke', src: 'controller', id: 'write1',
      payload: { channel: 'local-db:sessions:patch-meta', args: [{ id: 's1' }] } };
    const inject = () => relay.sockets.get('host')!.push(frame);
    inject(); inject();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { interval: 1 });
    await new Promise<void>(resolve => setImmediate(resolve)); inject();
    relay.sockets.get('host')!.push({ ...frame, payload: { channel: 'local-db:sessions:patch-meta', args: [{ id: 'other' }] } });
    await vi.waitFor(() => expect(relay.frames.some(item => item.kind === 'invoke-result'
      && JSON.stringify(item.payload).includes('identifier was reused'))).toBe(true), { interval: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a late old-owner result after stop/start and keeps unrelated operations responsive', async () => {
    const relay = new Relay();
    const pending = deferred<string>();
    const entered = deferred<TerminalRemoteContext>();
    let scope = 'owner:global:1';
    const host = make(relay, 'host', { getOwnerScope: () => scope,
      invokeLocal: async (_channel, args, context) => {
        if (args[0] === 'slow') { entered.resolve(context); return pending.promise; }
        return 'fast';
      } });
    const controller = make(relay, 'controller');
    await online(host, controller);
    relay.sockets.get('host')!.push({ v: PROTOCOL_VERSION, kind: 'invoke', src: 'controller', id: 'old-owner',
      payload: { channel: 'local-db:sessions:list', args: ['slow'] } });
    const context = await entered.promise;
    await expect(controller.invoke('host', 'local-db:sessions:list', ['fast'])).resolves.toBe('fast');
    host.stop(); scope = 'owner:global:2'; host.start(); await online(host);
    expect(context.signal.aborted).toBe(true);
    pending.resolve('private-old-owner-result');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(relay.frames.some(item => item.kind === 'invoke-result' && item.id === 'old-owner')).toBe(false);
  });

  it('lists devices with the current account token and rejects malformed entries', async () => {
    const relay = new Relay();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ devices: [{
      deviceId: 'host', name: 'Server', platform: 'linux', appVersion: '0.1', online: true,
      remoteControlEnabled: true, busy: false, lastSeenAt: '2026-10-23T01:00:00Z', isSelf: false,
    }] })));
    const controller = make(relay, 'controller', { fetch: fetchMock });
    await expect(controller.listDevices()).resolves.toMatchObject([{ deviceId: 'host', platform: 'linux' }]);
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://example.test/api/device-link/devices');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ authorization: 'Bearer token:controller' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ devices: [{ deviceId: 'forged' }] })));
    await expect(controller.listDevices()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('restores wanted subscriptions after socket loss and a deliberate disconnect stays closed', async () => {
    const relay = new Relay(), changes: string[][] = [], pushes = vi.fn();
    const host = make(relay, 'host', { onSubscriptionsChanged: (_source, topics) => { changes.push([...topics]); } });
    const controller = make(relay, 'controller', { onPush: pushes });
    await online(host, controller);
    await controller.subscribe('host', ['sessions']);
    const old = relay.sockets.get('controller')!;
    old.close(1006);
    await vi.waitFor(() => expect(relay.sockets.get('controller')).not.toBe(old), { interval: 1 });
    await online(controller);
    await controller.connect('host');
    await host.publish('local-db:sessions:patched', { sessionId: 's1' });
    await vi.waitFor(() => expect(pushes).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(changes.at(-1)).toEqual(['sessions']);
    controller.disconnect('host');
    await new Promise<void>(resolve => setImmediate(resolve));
    await host.publish('local-db:sessions:patched', { sessionId: 's1' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(pushes).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping host subscription updates without losing either observer', async () => {
    const relay = new Relay(), entered = deferred<void>(), release = deferred<void>();
    let first = true;
    let lastTopics: readonly string[] = [];
    const host = make(relay, 'host', { onSubscriptionsChanged: async (_source, topics) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      lastTopics = topics;
    } });
    const controller = make(relay, 'controller');
    await online(host, controller); await controller.connect('host');
    const firstSubscription = controller.subscribe('host', ['sessions']);
    await entered.promise;
    const secondSubscription = controller.subscribe('host', ['session:s1']);
    release.resolve();
    const [disposeFirst, disposeSecond] = await Promise.all([firstSubscription, secondSubscription]);
    expect([...lastTopics].sort()).toEqual(['session:s1', 'sessions']);
    await disposeFirst(); expect(lastTopics).toEqual(['session:s1']);
    await disposeSecond(); expect(lastTopics).toEqual([]);
  });
});
