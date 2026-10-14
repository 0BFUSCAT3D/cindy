import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision, type McpAppsHostDeps } from '../host.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
});

const result: CallToolResult = {
  content: [{ type: 'text', text: 'Completed draft' }],
  structuredContent: { completed: true },
  _meta: { viewOnly: 'private result' },
};
const completion = (kind: 'result' | 'cancelled') =>
  kind === 'result' ? { result } : { cancelled: 'Tool execution cancelled' };

function fixture() {
  const owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const uri = 'ui://form';
  const tool = {
    name: 'form',
    inputSchema: { type: 'object' as const },
    _meta: { ui: { resourceUri: uri } },
  };
  const card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: uri,
    tool,
    arguments: { title: 'Draft' },
  };
  const cards = new Map([
    ['card', card],
    ['other', { ...card }],
  ]);
  const readCard = vi.fn<McpAppsHostDeps['readCard']>(async (_sessionId, clientId) => {
    const current = cards.get(clientId);
    if (!current) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    return current;
  });
  const writeCard = vi.fn<McpAppsHostDeps['writeCard']>(async (_sessionId, clientId, record) => {
    if (!cards.has(clientId)) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    cards.set(clientId, record);
  });
  const dispose = vi.fn();
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({}) }),
    tools: async () => [tool],
    resource: async () => ({
      result: { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Form</p>' }] },
    }),
    listen: () => () => {},
    close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard,
    writeCard,
    authorizeTool: async () => {},
    sendMessage: async () => {},
    disposeDocument: dispose,
    connection: () => connection,
  });
  const connectionId = host.registerConnection(connection);
  for (const record of cards.values()) record.connectionId = connectionId;
  hosts.push(host);
  const sendResult = vi.spyOn(AppBridge.prototype, 'sendToolResult');
  const sendCancelled = vi.spyOn(AppBridge.prototype, 'sendToolCancelled');
  const sendInput = vi.spyOn(AppBridge.prototype, 'sendToolInput');
  return { host, card, cards, readCard, writeCard, dispose, sendResult, sendCancelled, sendInput };
}

async function open(host: McpAppsHost, caller: string, clientId = 'card') {
  const document = await host.open(caller, 'task', clientId, {});
  const viewId = document.viewId;
  await host.dispatch(caller, 'task', viewId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Result delivery fixture', version: '1' },
      appCapabilities: {},
    },
  });
  const events = await host.poll(caller, 'task', viewId, 0);
  expect(events.some((event) => event.message && 'result' in event.message)).toBe(true);
  return { caller, viewId, after: events.at(-1)!.seq };
}

async function initialize(host: McpAppsHost, view: Awaited<ReturnType<typeof open>>) {
  await host.dispatch(view.caller, 'task', view.viewId, {
    jsonrpc: '2.0',
    method: 'ui/notifications/initialized',
  });
  let input = false;
  while (!input) {
    const events = await host.poll(view.caller, 'task', view.viewId, view.after);
    view.after = events.at(-1)!.seq;
    input = events.some(
      (event) =>
        event.message &&
        'method' in event.message &&
        event.message.method === 'ui/notifications/tool-input',
    );
  }
}

describe('MCP App result delivery authorization', () => {
  it.each(['result', 'cancelled'] as const)(
    'disposes initialized and waiting Views without delivering %s when persistence rejects a revoked card',
    async (kind) => {
      const f = fixture();
      const local = await open(f.host, 'renderer:local');
      await initialize(f.host, local);
      const waiting = await open(f.host, 'device:phone');
      const other = await open(f.host, 'renderer:other', 'other');
      await initialize(f.host, other);
      const rejectedPoll = expect(
        f.host.poll(local.caller, 'task', local.viewId, local.after),
      ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');

      // readCard/writeCard reject cleared, rewound or deleted cards through the same contract.
      f.cards.delete('card');
      await expect(
        f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) }),
      ).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
      await rejectedPoll;
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
      expect(f.dispose.mock.calls).toEqual([[local.viewId], [waiting.viewId]]);
      await expect(initialize(f.host, waiting)).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');

      await f.host.updateResult('task', 'other', { ...f.card, result });
      const events = await f.host.poll(other.caller, 'task', other.viewId, other.after);
      expect(events).toContainEqual(
        expect.objectContaining({
          message: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result },
        }),
      );
      expect(f.sendResult).toHaveBeenCalledOnce();
      expect(f.dispose).not.toHaveBeenCalledWith(other.viewId);
    },
  );

  it('preserves a storage failure and fails closed even if the old card can still be read', async () => {
    const f = fixture();
    const view = await open(f.host, 'renderer:local');
    await initialize(f.host, view);
    const failure = new Error('STORAGE_FAILURE');
    f.writeCard.mockRejectedValueOnce(failure);
    await expect(f.host.updateResult('task', 'card', { ...f.card, result })).rejects.toBe(failure);
    expect(f.sendResult).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledWith(view.viewId);
  });

  it.each(['result', 'cancelled'] as const)(
    'revalidates the live card before sending %s after a successful write',
    async (kind) => {
      const f = fixture();
      const view = await open(f.host, 'renderer:local');
      await initialize(f.host, view);
      f.writeCard.mockImplementationOnce(async (_sessionId, clientId, record) => {
        f.cards.set(clientId, record);
        // Revocation can race with the persistence completion.
        f.cards.delete(clientId);
      });
      await expect(
        f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) }),
      ).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledWith(view.viewId);
    },
  );

  it.each(['result', 'cancelled'] as const)(
    'does not deliver saved %s or input when the card is revoked before initialization',
    async (kind) => {
      const f = fixture();
      const view = await open(f.host, 'renderer:local');
      await f.host.updateResult('task', 'card', { ...f.card, ...completion(kind) });
      f.cards.delete('card');
      await f.host.dispatch(view.caller, 'task', view.viewId, {
        jsonrpc: '2.0',
        method: 'ui/notifications/initialized',
      });
      await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledWith(view.viewId));
      expect(f.sendInput).not.toHaveBeenCalled();
      expect(f.sendResult).not.toHaveBeenCalled();
      expect(f.sendCancelled).not.toHaveBeenCalled();
    },
  );

  it.each(['result', 'cancelled'] as const)(
    'delivers %s once to active and later initialized Views while their card remains current',
    async (kind) => {
      const f = fixture();
      const active = await open(f.host, 'renderer:local');
      await initialize(f.host, active);
      const waiting = await open(f.host, 'device:phone');
      const record = { ...f.card, ...completion(kind) };
      await f.host.updateResult('task', 'card', record);
      await initialize(f.host, waiting);
      await f.host.updateResult('task', 'card', record);
      await vi.waitFor(() => {
        expect(kind === 'result' ? f.sendResult : f.sendCancelled).toHaveBeenCalledTimes(2);
      });
      expect(f.dispose).not.toHaveBeenCalled();
    },
  );
});
