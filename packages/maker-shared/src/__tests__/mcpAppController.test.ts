import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAppController, type AppRpc } from '../mcpAppController.js';
const document = {
  viewId: 'view',
  html: '<html></html>',
  csp: "default-src 'none'",
  prefersBorder: true,
};
const never = () => new Promise<unknown>(() => {});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
function fixture(poll: () => Promise<unknown> = never) {
  const invoke = vi.fn(
    async (_session: string, input: Record<string, unknown>): Promise<unknown> =>
      input.op === 'open' ? document : input.op === 'poll' ? poll() : {},
  );
  const post = vi.fn(),
    state = vi.fn(),
    error = vi.fn(),
    link = vi.fn(async () => {});
  const controller = new McpAppController(invoke, 'task', 'card', post, state, error, link);
  return { controller, invoke, post, state, error, link };
}
describe('MCP App transport lifecycle', () => {
  it('relays initialization and complete HTML only after sandbox ready', async () => {
    const f = fixture();
    await f.controller.open({});
    f.controller.sandboxReady('cindy-mcp-app://view-view/resource');
    expect(f.post).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: document.html, resourceUrl: 'cindy-mcp-app://view-view/resource' },
      }),
    );
    f.controller.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    expect(f.invoke).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({
        op: 'message',
        message: expect.objectContaining({ method: 'ui/notifications/initialized' }),
      }),
    );
    await f.controller.close();
  });
  it('closes a View that finishes opening after its card unmounts', async () => {
    let resolve!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const controller = new McpAppController(invoke, 'task', 'card', vi.fn(), vi.fn(), vi.fn());
    const pending = controller.open({});
    await controller.close();
    invoke.mockResolvedValueOnce({});
    resolve(document);
    expect(await pending).toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('task', { op: 'teardown', viewId: 'view' });
  });
  it('times out initialization and releases the View without restarting a write', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.open({});
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.error).toHaveBeenCalledOnce();
    expect(String(f.error.mock.calls[0][0])).toContain('MCP_APP_INITIALIZATION_TIMEOUT');
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'open')).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
  });
  it('retries only transient polling and never replays tools/call', async () => {
    vi.useFakeTimers();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockImplementation(never);
    const f = fixture(poll);
    await f.controller.open({});
    f.controller.sandboxReady();
    const request: AppRpc = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'submit' },
    };
    f.controller.receive(request);
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'message')).toHaveLength(1);
    expect(f.error).not.toHaveBeenCalled();
    await f.controller.close();
  });
  it('fails closed immediately for a revoked Host and discards its polling loop', async () => {
    const f = fixture(async () => {
      throw new Error('MCP_APP_SERVER_CHANGED');
    });
    await f.controller.open({});
    await flush();
    expect(f.error).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'poll')).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([, input]) => input.op === 'teardown')).toHaveLength(1);
  });
  it('consumes controller links without exposing host actions to the App', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce([{ seq: 1, openLink: { id: 'link', url: 'https://example.org/' } }])
      .mockImplementation(never);
    const f = fixture(poll);
    await f.controller.open({});
    f.controller.sandboxReady();
    await flush();
    expect(f.link).toHaveBeenCalledWith('https://example.org/');
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'link-result',
      viewId: 'view',
      linkId: 'link',
      success: true,
    });
    expect(f.post.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ openLink: expect.anything() }),
    );
    await f.controller.close();
  });
  it('host display changes never synthesize View request IDs', async () => {
    const f = fixture();
    await f.controller.open({});
    await f.controller.displayMode('inline');
    expect(f.invoke).toHaveBeenCalledWith('task', {
      op: 'display-mode',
      viewId: 'view',
      mode: 'inline',
    });
    expect(f.post).not.toHaveBeenCalled();
    await f.controller.close();
  });
});
