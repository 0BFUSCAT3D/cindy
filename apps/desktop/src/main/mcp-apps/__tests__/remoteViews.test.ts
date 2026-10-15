import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAppDocument } from '../../../shared/mcpApps.js';
const state = vi.hoisted(() => ({
  next: 0,
  mounts: new Map<string, { caller: string; document: McpAppDocument; frame: (raw: unknown) => Promise<unknown>; dispose: () => void }>(),
}));
vi.mock('../sandboxProtocol.js', () => ({
  mountRemoteAppDocument(document: McpAppDocument, caller: string, frame: (raw: unknown) => Promise<unknown>, dispose: () => void) {
    const id = `local-${++state.next}`;
    state.mounts.set(id, { caller, document, frame, dispose });
    return id;
  },
  assertMcpAppDocumentCaller(id: string, caller: string) {
    if (state.mounts.get(id)?.caller !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
  },
  unmountRemoteAppDocument(id: string, caller: string) {
    const entry = state.mounts.get(id);
    if (entry?.caller !== caller) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    state.mounts.delete(id);
    entry.dispose();
  },
}));
import { RemoteMcpAppViews } from '../remoteViews.js';
const document = { viewId: 'remote-view', html: '<p>Server-authored App</p>', csp: '', prefersBorder: true };
function fixture() {
  let owner: object | undefined = {};
  const invoke = vi.fn(async (_device: string, _session: string, input: Record<string, unknown>, preSend: () => void): Promise<unknown> => {
    preSend();
    if (input.op === 'open') return document;
    if (input.op === 'poll') return [];
    return {};
  });
  const openLink = vi.fn(async () => {});
  const views = new RemoteMcpAppViews({ owner: () => owner, invoke, openLink });
  const control = (input: Record<string, unknown>, caller = 'renderer:1', device = 'device-a', session = 'task') =>
    views.control(caller, device, session, input);
  const open = async () => await control({ op: 'open', clientId: 'card', openId: 'attempt', context: {} }) as McpAppDocument;
  return { invoke, openLink, views, control, open, changeOwner: () => { owner = {}; } };
}
beforeEach(() => { state.mounts.clear(); state.next = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('Main-bound remote MCP App Views', () => {
  it.each([
    { op: 'message', viewId: 'remote-view', message: { jsonrpc: '2.0', id: 1, method: 'tools/call' } },
    { op: 'poll', viewId: 'remote-view' },
    { op: 'authorize-link', viewId: 'remote-view', linkId: 'link' },
    { op: 'link-result', viewId: 'remote-view', linkId: 'link', success: true },
    { op: 'open-link', viewId: 'remote-view', url: 'https://example.org' },
    { op: 'mount-remote', document },
  ])('denies top Renderer transport operations without sending them: %j', async (input) => {
    const f = fixture();
    await f.open();
    f.invoke.mockClear();
    await expect(f.control(input)).rejects.toThrow('MCP_APP_FRAME_REQUIRED');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('supplies only the remote document and binds frame RPCs to Main-held device/task/View IDs', async () => {
    const f = fixture();
    const local = await f.open();
    expect(local).toEqual({ ...document, viewId: 'local-1', transport: 'sandbox' });
    expect(state.mounts.get(local.viewId)?.document).toEqual(document);
    const frame = state.mounts.get(local.viewId)!.frame;
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app-only' } };
    await frame({ op: 'message', viewId: 'forged', deviceId: 'forged', sessionId: 'forged', message });
    expect(f.invoke).toHaveBeenLastCalledWith('device-a', 'task',
      { op: 'message', viewId: 'remote-view', message }, expect.any(Function));
    await expect(frame({ op: 'open', clientId: 'forged' })).rejects.toThrow('MCP_APP_INVALID_REQUEST');
    for (const [caller, device, session] of [
      ['renderer:2', 'device-a', 'task'], ['renderer:1', 'device-b', 'task'], ['renderer:1', 'device-a', 'other'],
    ]) await expect(f.control({ op: 'context', viewId: local.viewId, context: {} }, caller, device, session))
      .rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('checks owner and the still-mounted View at the actual send and result boundaries', async () => {
    const f = fixture();
    const local = await f.open();
    const frame = state.mounts.get(local.viewId)!.frame;
    f.invoke.mockImplementationOnce(async (_device, _session, _input, preSend) => {
      f.changeOwner();
      preSend();
      return {};
    });
    await expect(frame({ op: 'message', message: { jsonrpc: '2.0', id: 1, method: 'tools/call' } }))
      .rejects.toThrow('MCP_APP_OWNER_CHANGED');
    await expect(frame({ op: 'poll' })).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('authorizes only a polled link immediately before opening the viewing computer browser', async () => {
    const f = fixture();
    const local = await f.open();
    const frame = state.mounts.get(local.viewId)!.frame;
    const link = { id: 'link', url: 'https://example.org/' };
    f.invoke.mockResolvedValueOnce([{ seq: 1, openLink: link }]);
    await frame({ op: 'poll' });
    await expect(frame({ op: 'open-link', linkId: 'link', url: 'https://forged.invalid' })).rejects.toThrow('MCP_APP_INVALID_LINK');
    // Old Hosts/missing receipts cannot grant the browser action.
    await expect(frame({ op: 'open-link', linkId: 'link', url: link.url })).rejects.toThrow('MCP_APP_LINK_NOT_AUTHORIZED');
    expect(f.openLink).not.toHaveBeenCalled();
    f.invoke.mockResolvedValueOnce({ authorized: true });
    await frame({ op: 'open-link', linkId: 'link', url: link.url });
    expect(f.invoke).toHaveBeenLastCalledWith('device-a', 'task',
      { op: 'authorize-link', viewId: 'remote-view', linkId: 'link' }, expect.any(Function));
    expect(f.openLink).toHaveBeenCalledExactlyOnceWith(link.url);
    await frame({ op: 'link-result', linkId: 'link', success: true });
    await expect(frame({ op: 'open-link', linkId: 'link', url: link.url })).rejects.toThrow('MCP_APP_INVALID_LINK');
  });
  it('drops a link authorization returned after owner revocation without opening or replaying it', async () => {
    const f = fixture();
    const local = await f.open();
    const frame = state.mounts.get(local.viewId)!.frame;
    f.invoke.mockResolvedValueOnce([{ seq: 1, openLink: { id: 'link', url: 'https://example.org/' } }]);
    await frame({ op: 'poll' });
    f.invoke.mockImplementationOnce(async () => { f.changeOwner(); return { authorized: true }; });
    await expect(frame({ op: 'open-link', linkId: 'link', url: 'https://example.org/' })).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    expect(f.openLink).not.toHaveBeenCalled();
  });
  it('retains the local frame during remote teardown and releases it once', async () => {
    const f = fixture();
    const local = await f.open();
    let finish!: (result: unknown) => void;
    f.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const close = f.control({ op: 'teardown', viewId: local.viewId, alreadyNotified: true });
    expect(state.mounts.has(local.viewId)).toBe(true);
    finish({});
    await close;
    expect(state.mounts.has(local.viewId)).toBe(false);
    expect(f.invoke.mock.calls.filter((call) => call[2].op === 'teardown')).toHaveLength(1);
    expect(f.invoke).toHaveBeenLastCalledWith('device-a', 'task',
      { op: 'teardown', viewId: 'remote-view' }, expect.any(Function));
  });
  it('does not open a late authorized link while the retained frame is closing', async () => {
    const f = fixture();
    const local = await f.open();
    const frame = state.mounts.get(local.viewId)!.frame;
    f.invoke.mockResolvedValueOnce([{ seq: 1, openLink: { id: 'link', url: 'https://example.org/' } }]);
    await frame({ op: 'poll' });
    let authorize!: (result: unknown) => void;
    let finishClose!: (result: unknown) => void;
    f.invoke.mockImplementationOnce(() => new Promise((resolve) => { authorize = resolve; }));
    const late = frame({ op: 'open-link', linkId: 'link', url: 'https://example.org/' });
    f.invoke.mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
    const closing = f.control({ op: 'teardown', viewId: local.viewId });
    expect(state.mounts.has(local.viewId)).toBe(true);
    authorize({ authorized: true });
    await expect(late).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    expect(f.openLink).not.toHaveBeenCalled();
    finishClose({});
    await closing;
  });
  it('namespaces pending opens and cancels late Views only for the exiting caller', async () => {
    const f = fixture();
    let finish!: (result: unknown) => void;
    f.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.open();
    const rejected = expect(pending).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    const remoteOpenId = f.invoke.mock.calls[0][2].openId;
    expect(remoteOpenId).not.toBe('attempt');
    const other = await f.control({ op: 'open', clientId: 'other', openId: 'attempt' }, 'renderer:2') as McpAppDocument;
    await f.views.releaseCaller('renderer:1');
    finish(document);
    await rejected;
    expect(f.invoke).toHaveBeenCalledWith('device-a', 'task',
      { op: 'cancel-open', openId: remoteOpenId }, expect.any(Function));
    expect(state.mounts.has(other.viewId)).toBe(true);
    expect(state.mounts.size).toBe(1);
  });
  it('retries only the failing View read while another controller continues without interruption', async () => {
    const f = fixture();
    const local = await f.open();
    const other = await f.control({ op: 'open', clientId: 'card' }, 'renderer:2', 'device-b') as McpAppDocument;
    const frame = state.mounts.get(local.viewId)!.frame;
    const otherFrame = state.mounts.get(other.viewId)!.frame;
    vi.useFakeTimers();
    f.invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] transport stalled'));
    const retrying = frame({ op: 'poll' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await otherFrame({ op: 'poll' })).toEqual([]);
    expect(state.mounts.size).toBe(2);
    const calls = f.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(await retrying).toEqual([]);
    expect(f.invoke.mock.calls.slice(calls).map((call) => [call[0], call[2].op])).toEqual([['device-a', 'poll']]);
    expect(f.invoke.mock.calls.some((call) => ['teardown', 'cancel-open'].includes(String(call[2].op)))).toBe(false);
  });
  it('never replays App writes after a transport failure', async () => {
    const f = fixture();
    const local = await f.open();
    vi.useFakeTimers();
    f.invoke.mockClear();
    f.invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] outcome unknown'));
    await expect(state.mounts.get(local.viewId)!.frame({ op: 'message',
      message: { jsonrpc: '2.0', id: 1, method: 'tools/call' } })).rejects.toThrow('outcome unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.invoke).toHaveBeenCalledOnce();
  });
  it('releases the caller pending-open quota immediately and discards each late View', async () => {
    const f = fixture();
    const finishes: Array<(result: unknown) => void> = [];
    f.invoke.mockImplementation(async (_device, _session, input, preSend) => {
      preSend();
      return input.op === 'open' ? new Promise((resolve) => finishes.push(resolve)) : {};
    });
    const pending = Array.from({ length: 16 }, () => expect(f.open()).rejects.toThrow('MCP_APP_OPEN_CANCELLED'));
    await expect(f.open()).rejects.toThrow('MCP_APP_VIEW_LIMIT');
    await f.views.releaseCaller('renderer:1');
    f.invoke.mockResolvedValueOnce(document);
    expect(await f.open()).toHaveProperty('transport', 'sandbox');
    finishes.forEach((finish) => finish(document));
    await Promise.all(pending);
    expect(state.mounts.size).toBe(1);
  });
  it('stops a failed read after its bounded retry window', async () => {
    const f = fixture();
    const local = await f.open();
    vi.useFakeTimers();
    f.invoke.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] transport stalled'));
    const failed = expect(state.mounts.get(local.viewId)!.frame({ op: 'poll' })).rejects.toThrow('transport stalled');
    await vi.advanceTimersByTimeAsync(35_000);
    await failed;
    const calls = f.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.invoke.mock.calls).toHaveLength(calls);
  });
  it('does not send a sleeping read again after its caller is released', async () => {
    const f = fixture();
    const local = await f.open();
    vi.useFakeTimers();
    f.invoke.mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] transport stalled'));
    const failed = expect(state.mounts.get(local.viewId)!.frame({ op: 'poll' })).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(0);
    await f.views.releaseCaller('renderer:1');
    const polls = f.invoke.mock.calls.filter((call) => call[2].op === 'poll').length;
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(f.invoke.mock.calls.filter((call) => call[2].op === 'poll')).toHaveLength(polls);
    expect(state.mounts.size).toBe(0);
  });
});
