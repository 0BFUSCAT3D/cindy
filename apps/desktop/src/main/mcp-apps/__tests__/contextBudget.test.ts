import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision } from '../host.js';

type ContextParams = { structuredContent: { draft: string } };
const hosts: McpAppsHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
});

function sizedContext(bytes: number, unit = '汉'): ContextParams {
  const empty = { structuredContent: { draft: '' } };
  const available = bytes - Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const unitBytes =
    Buffer.byteLength(JSON.stringify({ structuredContent: { draft: unit } }), 'utf8') -
    Buffer.byteLength(JSON.stringify(empty), 'utf8');
  return {
    structuredContent: {
      draft: unit.repeat(Math.floor(available / unitBytes)) + 'x'.repeat(available % unitBytes),
    },
  };
}

function contextValue(params: ContextParams) {
  return { app: 'example', resourceUri: 'ui://form', ...params };
}

function contextJson(text: string) {
  return text.split('\n')[2];
}

function fixture() {
  let owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const tool = {
    name: 'form',
    inputSchema: { type: 'object' as const },
    _meta: { ui: { resourceUri: 'ui://form' } },
  };
  const record = {
    version: 1 as const,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: 'ui://form',
    tool,
    arguments: {},
  };
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({}) }),
    tools: async () => [tool],
    resource: async () => ({
      result: {
        contents: [{ uri: 'ui://form', mimeType: 'text/html;profile=mcp-app', text: '' }],
      },
    }),
    listen: () => () => {},
    close: async () => {},
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
  // Context budgeting does not exercise the separate teardown handshake.
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async () => record,
    writeCard: async () => {},
    authorizeTool: async () => {},
    sendMessage: async () => {},
    connection: () => connection,
  });
  hosts.push(host);
  let requestId = 0;
  return {
    host,
    changeOwner() {
      owner = {};
    },
    async open(clientId: string, sessionId = 'task') {
      const document = await host.open('renderer:1', sessionId, clientId, {});
      const request = async (method: string, params: Record<string, unknown>) => {
        const id = ++requestId;
        await host.dispatch('renderer:1', sessionId, document.viewId, {
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
        await vi.waitFor(() => expect(outgoing).toContainEqual(expect.objectContaining({ id })));
        return outgoing.find((message) => 'id' in message && message.id === id)!;
      };
      await request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'Context budget fixture', version: '1' },
        appCapabilities: {},
      });
      await host.dispatch('renderer:1', sessionId, document.viewId, {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      });
      return (params: ContextParams) => request('ui/update-model-context', params);
    },
  };
}

describe('MCP App UTF-8 model-context budgets', () => {
  it.each(['汉', '🧩', '"', '\u0001'])(
    'counts serialized UTF-8 bytes for %j at the per-update boundary',
    async (unit) => {
      const f = fixture();
      const update = await f.open('card');
      const params = sizedContext(128_000, unit);
      expect(Buffer.byteLength(JSON.stringify(params), 'utf8')).toBe(128_000);
      expect(await update(params)).toHaveProperty('result');
      const accepted = await f.host.modelContext('task');
      expect(JSON.parse(contextJson(accepted.text))).toEqual([contextValue(params)]);

      const oversized = { structuredContent: { draft: params.structuredContent.draft + 'x' } };
      expect(await update(oversized)).toHaveProperty(
        'error.message',
        expect.stringContaining('MCP_APP_CONTEXT_TOO_LARGE'),
      );
      expect((await f.host.modelContext('task')).text).toBe(accepted.text);
    },
  );

  it('includes the full context array and preserves valid values after an aggregate overflow', async () => {
    const f = fixture();
    const maximum = sizedContext(128_000, '🧩');
    const previous = [];
    for (let index = 0; index < 3; index++) {
      const update = await f.open(`card-${index}`);
      expect(await update(maximum)).toHaveProperty('result');
      previous.push(contextValue(maximum));
    }
    const update = await f.open('card-3');
    const empty = { structuredContent: { draft: '' } };
    const available =
      512_000 - Buffer.byteLength(JSON.stringify([...previous, contextValue(empty)]), 'utf8');
    const exact = sizedContext(Buffer.byteLength(JSON.stringify(empty), 'utf8') + available);
    const oversized = { structuredContent: { draft: exact.structuredContent.draft + 'x' } };
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThan(128_000);
    expect(await update(oversized)).toHaveProperty(
      'error.message',
      expect.stringContaining('MCP_APP_CONTEXT_TOO_LARGE'),
    );
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual(previous);
    expect(await update(exact)).toHaveProperty('result');
    const full = await f.host.modelContext('task');
    expect(Buffer.byteLength(contextJson(full.text), 'utf8')).toBe(512_000);
    expect(JSON.parse(contextJson(full.text))).toEqual([...previous, contextValue(exact)]);

    const otherTask = await f.open('card-0', 'another-task');
    expect(await otherTask(maximum)).toHaveProperty('result');
    expect(JSON.parse(contextJson((await f.host.modelContext('another-task')).text))).toEqual([
      contextValue(maximum),
    ]);
    expect((await f.host.modelContext('task')).text).toBe(full.text);
  });

  it('reclaims the replaced context budget without consuming a later update', async () => {
    const f = fixture();
    const update = await f.open('card');
    const large = sizedContext(128_000);
    for (let index = 0; index < 3; index++) {
      const other = await f.open(`other-${index}`);
      expect(await other(large)).toHaveProperty('result');
    }
    const first = sizedContext(64_000);
    expect(await update(first)).toHaveProperty('result');
    const snapshot = await f.host.modelContext('task');
    const replacement = sizedContext(100_000);
    expect(await update(replacement)).toHaveProperty('result');
    snapshot.consume();
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual([
      contextValue(replacement),
    ]);
    const next = await f.open('next');
    expect(await next(large)).toHaveProperty('result');
  });

  it('keeps context budgets separate across accounts', async () => {
    const f = fixture();
    const maximum = sizedContext(128_000);
    for (let index = 0; index < 3; index++) {
      const update = await f.open(`card-${index}`);
      expect(await update(maximum)).toHaveProperty('result');
    }
    f.changeOwner();
    expect((await f.host.modelContext('task')).text).toBe('');
    const update = await f.open('new-account-card');
    expect(await update(maximum)).toHaveProperty('result');
    expect(JSON.parse(contextJson((await f.host.modelContext('task')).text))).toEqual([
      contextValue(maximum),
    ]);
  });
});
