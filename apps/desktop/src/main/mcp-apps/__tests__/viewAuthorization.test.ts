import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision } from '../host.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const marker = 'private-upstream-result';
const tool = {
  name: 'form',
  description: marker,
  inputSchema: { type: 'object' as const },
  _meta: { ui: { resourceUri: 'ui://form' } },
};
const requests = [
  [
    'tools/call',
    { name: tool.name, arguments: {} },
    'callTool',
    { content: [{ type: 'text', text: marker }] },
  ],
  ['tools/list', {}, 'tools', [tool]],
  [
    'resources/read',
    { uri: 'data://private' },
    'readResource',
    { contents: [{ uri: 'data://private', text: marker }] },
  ],
  ['resources/list', {}, 'listResources', { resources: [{ name: marker, uri: 'data://private' }] }],
  [
    'resources/templates/list',
    {},
    'listResourceTemplates',
    { resourceTemplates: [{ name: marker, uriTemplate: 'data://{id}' }] },
  ],
  ['prompts/list', {}, 'listPrompts', { prompts: [{ name: marker }] }],
] as const;

async function fixture() {
  let owner = {};
  let enabled = true;
  let visible = true;
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: 'ui://form',
    tool,
    arguments: {},
  };
  const methods = {
    callTool: vi.fn(),
    tools: vi.fn(async () => [tool]),
    readResource: vi.fn(),
    listResources: vi.fn(),
    listResourceTemplates: vi.fn(),
    listPrompts: vi.fn(),
  };
  const connection = {
    getClient: async () => ({
      ...methods,
      getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
    }),
    tools: methods.tools,
    resource: async () => ({
      result: {
        contents: [
          { uri: card.resourceUri, mimeType: 'text/html;profile=mcp-app', text: '<p>Form</p>' },
        ],
      },
    }),
    listen: () => () => {},
    close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const outgoing: JSONRPCMessage[] = [];
  const connect = AppBridge.prototype.connect;
  vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(function (
    this: AppBridge,
    transport,
  ) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      outgoing.push(message);
      await send(message, options);
    };
    return connect.call(this, transport);
  });
  // These cases exercise request completion, not the separate bounded teardown handshake.
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const authorizeTool = vi.fn(async () => {});
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => (enabled ? config : undefined),
    readCard: async () => {
      if (!visible) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return card;
    },
    writeCard: async () => {},
    authorizeTool,
    sendMessage: async () => {},
    connection: () => connection,
  });
  hosts.push(host);
  const document = await host.open('renderer:1', 'task', 'card', {});
  const dispatch = (message: JSONRPCMessage) =>
    host.dispatch('renderer:1', 'task', document.viewId, message);
  await dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Authorization fixture', version: '1' },
      appCapabilities: {},
    },
  });
  await vi.waitFor(() =>
    expect(outgoing).toContainEqual(expect.objectContaining({ id: 1, result: expect.anything() })),
  );
  await dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.waitFor(() =>
    expect(outgoing).toContainEqual(
      expect.objectContaining({ method: 'ui/notifications/tool-input' }),
    ),
  );
  outgoing.length = 0;
  return {
    methods,
    outgoing,
    dispatch,
    config,
    authorizeTool,
    revoke(kind: 'card' | 'owner' | 'server' | 'config') {
      if (kind === 'card') visible = false;
      if (kind === 'owner') owner = {};
      if (kind === 'server') enabled = false;
      if (kind === 'config') config.url = 'https://changed.example.invalid';
    },
  };
}

describe('MCP App upstream result authorization', () => {
  it.each(['card', 'owner', 'server', 'config'] as const)(
    'does not request tool approval after %s revocation during tool discovery',
    async (revocation) => {
      const f = await fixture();
      const pending = deferred<Array<typeof tool>>();
      f.methods.tools.mockClear().mockReturnValueOnce(pending.promise);
      await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
      await vi.waitFor(() => expect(f.methods.tools).toHaveBeenCalledOnce());
      f.revoke(revocation);
      pending.resolve([tool]);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(f.authorizeTool).not.toHaveBeenCalled();
      expect(f.methods.callTool).not.toHaveBeenCalled();
      expect(f.methods.tools).toHaveBeenCalledOnce();
    },
  );

  it('requests approval once after slow tool discovery when the View remains current', async () => {
    const f = await fixture();
    const pending = deferred<Array<typeof tool>>();
    f.methods.tools.mockClear().mockReturnValueOnce(pending.promise);
    f.methods.callTool.mockResolvedValueOnce(requests[0][3]);
    await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
    await vi.waitFor(() => expect(f.methods.tools).toHaveBeenCalledOnce());
    expect(f.authorizeTool).not.toHaveBeenCalled();
    pending.resolve([tool]);
    await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
    expect(f.outgoing).toContainEqual({ jsonrpc: '2.0', id: 2, result: requests[0][3] });
    expect(f.authorizeTool).toHaveBeenCalledExactlyOnceWith(
      'task',
      tool,
      {},
      expect.any(AbortSignal),
    );
    expect(f.methods.callTool).toHaveBeenCalledOnce();
    expect(f.methods.tools).toHaveBeenCalledOnce();
  });

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'discards a completed App tool result after %s revocation without replaying it',
    async (revocation) => {
      const f = await fixture();
      const pending = deferred<unknown>();
      f.methods.callTool.mockReturnValueOnce(pending.promise);
      await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
      await vi.waitFor(() => expect(f.methods.callTool).toHaveBeenCalledOnce());
      f.revoke(revocation);
      pending.resolve(requests[0][3]);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(JSON.stringify(f.outgoing)).not.toContain(marker);
      expect(f.methods.callTool).toHaveBeenCalledOnce();
    },
  );

  it.each(requests.slice(1))(
    'discards %s results if the card is revoked while awaiting the server',
    async (method, params, upstream, result) => {
      const f = await fixture();
      const pending = deferred<unknown>();
      const operation = f.methods[upstream];
      operation.mockReturnValueOnce(pending.promise as never);
      operation.mockClear();
      await f.dispatch({ jsonrpc: '2.0', id: 2, method, params });
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      f.revoke('card');
      pending.resolve(result);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(JSON.stringify(f.outgoing)).not.toContain(marker);
      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it.each(requests)(
    'delivers %s results once when the View remains authorized',
    async (method, params, upstream, result) => {
      const f = await fixture();
      const operation = f.methods[upstream];
      operation.mockResolvedValueOnce(result as never);
      operation.mockClear();
      await f.dispatch({ jsonrpc: '2.0', id: 2, method, params });
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual({
        jsonrpc: '2.0',
        id: 2,
        result: upstream === 'tools' ? { tools: result } : result,
      });
      expect(operation).toHaveBeenCalledOnce();
    },
  );
});
