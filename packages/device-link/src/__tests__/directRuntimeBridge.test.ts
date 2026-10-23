import { afterEach, expect, it, vi } from 'vitest';
import { createDirectRuntimeBridge, type DirectRuntimeCommand } from '../directRuntimeBridge.js';
import { DirectLinkNegotiator, parseDirectSignal, type DirectRuntimeEvents } from '../directNegotiation.js';

// Production bridge/negotiator lifetimes absent from #6825: native queue pressure,
// stale callbacks, pending handshake cancellation and authenticated stream binding.
// Unit tier: in-memory native messages, fake time, no sockets or platform processes.
afterEach(() => vi.useRealTimers());
const observers = () => ({ open: vi.fn(), message: vi.fn(), drained: vi.fn(), closed: vi.fn() });

it('counts UTF-8 bytes still crossing the native bridge and ignores stale buffer acknowledgements', async () => {
  const bridge = createDirectRuntimeBridge(), events = observers(), sent: DirectRuntimeCommand[] = [];
  const detach = bridge.attach(c => sent.push(c));
  const session = bridge.runtime.create('one', events);
  bridge.receive({ type: 'open', connection: 'one' });
  session.send('😀');
  expect(session.bufferedAmount).toBe(4);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 1, buffered: 512 });
  expect(session.bufferedAmount).toBe(512);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 0, buffered: 0 });
  expect(session.bufferedAmount).toBe(512);
  bridge.receive({ type: 'buffer', connection: 'one', sequence: 1, buffered: 0 });
  await Promise.resolve();
  expect(session.bufferedAmount).toBe(0);
  expect(events.drained).toHaveBeenCalled();
  expect(sent[0]).toMatchObject({ action: 'send', sequence: 1, text: '😀' });
  detach();
});

it('releases pending operations on native loss and refuses late replies or frames from that process', async () => {
  const bridge = createDirectRuntimeBridge(), events = observers(), sent: DirectRuntimeCommand[] = [];
  const detach = bridge.attach(c => sent.push(c));
  const session = bridge.runtime.create('one', events);
  const result = session.offer();
  const rejected = expect(result).rejects.toThrow('CLOSED');
  detach(); await rejected;
  bridge.receive({ type: 'reply', id: sent[0].id, ok: true, value: 'late-sdp' });
  bridge.receive({ type: 'open', connection: 'one' });
  bridge.receive({ type: 'message', connection: 'one', text: 'late-frame' });
  expect(events.closed).toHaveBeenCalledOnce();
  expect(events.open).not.toHaveBeenCalled(); expect(events.message).not.toHaveBeenCalled();
  expect(() => session.send('late-send')).toThrow('CLOSED');
});

it('bounds a stalled native command without affecting another peer', async () => {
  vi.useFakeTimers();
  const bridge = createDirectRuntimeBridge(), one = observers(), two = observers();
  const detach = bridge.attach(() => {});
  const first = bridge.runtime.create('one', one), second = bridge.runtime.create('two', two);
  bridge.receive({ type: 'open', connection: 'two' });
  const result = first.offer(), rejected = expect(result).rejects.toThrow('TIMEOUT');
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(one.closed).toHaveBeenCalledOnce(); expect(two.closed).not.toHaveBeenCalled();
  expect(() => second.send('healthy')).not.toThrow();
  detach();
});

it('does not revive an authorized peer after its in-flight offer is cancelled', async () => {
  vi.useFakeTimers();
  let resolve!: (sdp: string) => void, callbacks!: DirectRuntimeEvents;
  const close = vi.fn(), signal = vi.fn(), attach = vi.fn();
  const controller = new DirectLinkNegotiator({
    runtime: { create(_id, events) { callbacks = events; return { offer: () => new Promise(r => { resolve = r; }),
      accept: async () => 'answer', answer: async () => {}, send() {}, bufferedAmount: 0, close }; } },
    identity: () => 'a', streams: () => ({ local: 'a-stream', remote: 'b-stream' }),
    id: () => 'attempt', signal, attach,
  });
  controller.ready('b'); controller.forget('b');
  resolve('late-offer'); callbacks.open(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(65_000);
  expect(signal).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('binds incoming negotiation to both current transport streams', async () => {
  const create = vi.fn();
  const controller = new DirectLinkNegotiator({ runtime: { create }, identity: () => 'b',
    streams: () => ({ local: 'b-new', remote: 'a-new' }), id: () => 'id', signal() {}, attach: vi.fn(),
  });
  for (const [stream, targetStream] of [['a-old', 'b-new'], ['a-new', 'b-old']]) {
    controller.receive('a', { action: 'offer', id: 'old-offer', stream, targetStream, sdp: 'offer' });
  }
  expect(create).not.toHaveBeenCalled();
  expect(parseDirectSignal({ action: 'offer', id: 'valid', stream: 'a', targetStream: 'b', sdp: 'x'.repeat(128 * 1024 + 1) })).toBeNull();
  expect(parseDirectSignal({ action: 'offer', id: 'valid', stream: 'a', targetStream: 'b' })).toBeNull();
  controller.clear();
});
