import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAppsHost, appServerRevision } from '../host.js';
import type { AppConnection } from '../connection.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.useRealTimers();
});
function fixture() {
  const owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const tool = { name: 'form', inputSchema: { type: 'object' as const }, _meta: { ui: { resourceUri: 'ui://form' } } };
  const record = { version: 1 as const, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form', tool, arguments: {} };
  const resource = vi.fn<AppConnection['resource']>(async () => ({
    result: { contents: [{ uri: record.resourceUri, mimeType: 'text/html;profile=mcp-app', text: '<html>form</html>' }] },
  }));
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({}) }),
    tools: async () => [tool], resource, listen: () => () => {}, close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const disposeDocument = vi.fn();
  const host = new McpAppsHost({ owner: () => owner, config: () => config, readCard: async () => record,
    writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
    connection: () => connection, disposeDocument });
  hosts.push(host);
  return { host, resource, disposeDocument, connection };
}
describe('MCP App open cancellation', () => {
  it('reclaims a reloaded caller quota immediately without closing shared connections', async () => {
    const f = fixture();
    const old = [];
    for (let i = 0; i < 16; i++) old.push(await f.host.open('renderer:1', 'task', 'card', {}));
    const other = await f.host.open('renderer:2', 'task', 'card', {});
    const phone = await f.host.open('device:phone', 'task', 'card', {});
    await expect(f.host.open('renderer:1', 'task', 'card', {})).rejects.toThrow('MCP_APP_VIEW_LIMIT');

    const cleanup = f.host.releaseCaller('renderer:1');
    // No sweep, asynchronous iframe teardown or connection shutdown may delay reuse.
    expect(f.disposeDocument).toHaveBeenCalledTimes(16);
    for (const document of old) {
      expect(f.disposeDocument).toHaveBeenCalledWith(document.viewId);
      expect(() => f.host.context('renderer:1', 'task', document.viewId, {})).toThrow('MCP_APP_VIEW_UNAVAILABLE');
    }
    for (let i = 0; i < 16; i++) await f.host.open('renderer:1', 'task', 'card', {});
    await cleanup;
    expect(() => f.host.context('renderer:2', 'task', other.viewId, {})).not.toThrow();
    expect(() => f.host.context('device:phone', 'task', phone.viewId, {})).not.toThrow();
    expect(f.connection.close).not.toHaveBeenCalled();
  });

  it('cancels only the exiting caller pending loads and refuses their late Views', async () => {
    const f = fixture();
    const data = await f.resource('ui://form');
    let finish!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(data); }));
    const slow = f.host.open('renderer:1', 'task', 'card', {}, 'old');
    const rejected = expect(slow).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const other = await f.host.open('renderer:2', 'task', 'card', {});
    let finishOther!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finishOther = () => resolve(data); }));
    const otherPending = f.host.open('device:phone', 'task', 'card', {});
    await vi.waitFor(() => expect(finishOther).toBeDefined());
    await f.host.releaseCaller('renderer:1');
    await rejected;
    finish();
    finishOther();
    expect(await otherPending).toHaveProperty('viewId');
    expect(() => f.host.context('renderer:2', 'task', other.viewId, {})).not.toThrow();
    expect(f.disposeDocument).not.toHaveBeenCalled();
    expect(f.connection.close).not.toHaveBeenCalled();
    for (let i = 0; i < 16; i++) await f.host.open('renderer:1', 'task', 'card', {}, `replacement-${i}`);
  });

  it('cancels a pending open without touching another controller or replaying anything', async () => {
    const f = fixture();
    const healthy = await f.host.open('device:healthy', 'task', 'card', {}, 'same-id');
    const data = await f.resource('ui://form');
    let finish!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(data); }));
    const slow = f.host.open('device:slow', 'task', 'card', {}, 'same-id');
    const rejected = expect(slow).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.host.cancelOpen('device:slow', 'task', 'same-id');
    await rejected;
    finish();
    await Promise.resolve();
    expect(() => f.host.context('device:healthy', 'task', healthy.viewId, { theme: 'dark' })).not.toThrow();
    expect(f.disposeDocument).not.toHaveBeenCalledWith(healthy.viewId);
    expect(f.resource).toHaveBeenCalledTimes(3);
  });
  it('reclaims a View when its open response was lost, scoped to caller and task', async () => {
    const f = fixture();
    const doc = await f.host.open('device:phone', 'task', 'card', {}, 'attempt');
    await f.host.cancelOpen('device:other', 'task', 'attempt');
    await f.host.cancelOpen('device:phone', 'other-task', 'attempt');
    expect(() => f.host.context('device:phone', 'task', doc.viewId, {})).not.toThrow();
    await f.host.cancelOpen('device:phone', 'task', 'attempt');
    expect(f.disposeDocument).toHaveBeenCalledWith(doc.viewId);
    expect(() => f.host.context('device:phone', 'task', doc.viewId, {})).toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('remembers cancellation that arrives before open and permits a different attempt', async () => {
    const f = fixture();
    await f.host.cancelOpen('device:phone', 'task', 'old');
    await expect(f.host.open('device:phone', 'task', 'card', {}, 'old')).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    expect(f.resource).not.toHaveBeenCalled();
    expect(await f.host.open('device:phone', 'task', 'card', {}, 'new')).toHaveProperty('viewId');
  });
  it('bounds loading at 90 seconds and never publishes a late document', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let aborted = false;
    f.resource.mockImplementationOnce((_uri, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); });
    }));
    const pending = f.host.open('device:phone', 'task', 'card', {}, 'attempt');
    const rejected = expect(pending).rejects.toThrow('MCP_APP_OPEN_TIMEOUT');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(aborted).toBe(true);
    expect(f.disposeDocument).not.toHaveBeenCalled();
    expect(f.connection.close).toHaveBeenCalled();
  });
});
