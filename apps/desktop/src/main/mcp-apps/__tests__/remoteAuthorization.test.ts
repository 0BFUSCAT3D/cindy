import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@cindy/maker-core';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import { registerAppServer, clearAppServerConfigs } from '../runtime.js';
import {
  startCodexHttpBridge,
  selectRemoteInjectableServerNames,
  type CodexHttpBridge,
} from '../../mcp-integrations/codexHttpBridge.js';
import { CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY } from '../../mcp-integrations/codexBuiltinToolPolicy.js';
let bridge: CodexHttpBridge | undefined;
const receivedNotification = vi.fn();
const log = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
} as Logger;
function server() {
  const server = new McpServer({ name: 'example', version: '1' });
  server.server.fallbackNotificationHandler = async (notification) => {
    receivedNotification(notification, getLiziMcpSessionContext()?.sessionInstanceId);
  };
  server.tool('context', {}, async () => ({
    content: [{ type: 'text', text: getLiziMcpSessionContext()?.sessionInstanceId ?? 'unbound' }],
  }));
  return server;
}
afterEach(async () => {
  clearAppServerConfigs();
  await bridge?.shutdown();
  bridge = undefined;
  receivedNotification.mockClear();
});
const headers = {
  authorization: 'Bearer invalid-test-only-remote-token',
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};
async function fixture(vendorOptions: Record<string, unknown> = {}) {
  for (const id of ['example', 'not-mounted'])
    registerAppServer(id, () => ({ id, url: 'http://127.0.0.1:1/mcp', transport: 'http' }));
  bridge = await startCodexHttpBridge({
    serverFactories: { example: server, 'not-mounted': server, cindy_ssh: server },
    appServerNames: ['example'],
    additionalBearerTokens: () => ['invalid-test-only-remote-token'],
    logger: log,
  });
  bridge.registerSessionCtx('task', {
    agentKind: 'claude-code',
    sessionId: 'task',
    sessionInstanceId: 'instance',
    workingDir: '/remote',
    remoteHostId: 'host',
    vendorOptions,
  });
  const base = bridge.url('example');
  const bound = base + '?session=task&instance=instance';
  const init = await fetch(bound, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const id = init.headers.get('mcp-session-id')!;
  await init.text();
  const request = async (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': id },
      body: JSON.stringify(body),
    });
  return { base, bound, request };
}
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const call = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'context', arguments: {} },
};
describe('MCP Apps over the existing remote bridge', () => {
  it('permits the configured custom server only with the actual Session instance', async () => {
    const f = await fixture();
    const reply = await f.request(f.bound, call);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain('instance');
    for (const url of [f.base, f.base + '?session=task', f.base + '?session=task&instance=stale']) {
      const denied = await f.request(url, call);
      expect(denied.status).toBe(401);
      await denied.text();
    }
  });
  it('allows unbound discovery but rejects resource access and a batch containing execution', async () => {
    const f = await fixture();
    const discovery = await f.request(f.base, list);
    expect(discovery.status).toBe(200);
    await discovery.text();
    for (const body of [
      { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://example/app' } },
      [list, call],
    ]) {
      const denied = await f.request(f.base, body);
      expect(denied.status).toBe(401);
      await denied.text();
    }
  });
  it('requires a Session for standard and extension notifications, including mixed batches', async () => {
    const f = await fixture();
    const notifications = [
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'test', progress: 1 } },
      { jsonrpc: '2.0', method: 'example/side-effect', params: { value: 'test' } },
    ];
    for (const body of [...notifications, [list, notifications[2]]]) {
      const denied = await f.request(f.base, body);
      expect(denied.status).toBe(401);
      await denied.text();
    }
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('keeps the initialization notification available before Session binding', async () => {
    const f = await fixture();
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const allowed = await f.request(f.base, initialized);
    expect(allowed.status).toBe(202);
    await allowed.text();
    // A method name alone must not turn a request into a handshake exemption.
    const denied = await f.request(f.base, { ...initialized, id: 4 });
    expect(denied.status).toBe(401);
    await denied.text();
  });
  it('forwards a notification with the verified Session context and rejects revoked routes', async () => {
    const f = await fixture();
    const notification = { jsonrpc: '2.0', method: 'example/side-effect', params: { value: 'test' } };
    const allowed = await f.request(f.bound, notification);
    expect(allowed.status).toBe(202);
    await allowed.text();
    await vi.waitFor(() => expect(receivedNotification).toHaveBeenCalledWith(notification, 'instance'));
    receivedNotification.mockClear();
    for (const url of [f.base + '?session=task', f.base + '?session=task&instance=stale']) {
      const denied = await f.request(url, notification);
      expect(denied.status).toBe(401);
      await denied.text();
    }
    bridge!.unregisterSessionCtx('task');
    const revoked = await f.request(f.bound, notification);
    expect(revoked.status).toBe(401);
    await revoked.text();
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('enforces the frozen custom-server mount for notifications as well', async () => {
    const f = await fixture({
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
      cindyRuntimeMcpServerNames: [],
    });
    const notification = { jsonrpc: '2.0', method: 'example/side-effect' };
    const denied = await f.request(f.bound, notification);
    expect(denied.status).toBe(401);
    await denied.text();
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('never exposes unrelated local servers or a custom server absent from this bridge', async () => {
    const f = await fixture();
    for (const name of ['not-mounted', 'cindy_ssh']) {
      const denied = await f.request(bridge!.url(name), list);
      expect(denied.status).toBe(403);
      await denied.text();
    }
    clearAppServerConfigs();
    const revoked = await f.request(f.bound, call);
    expect(revoked.status).toBe(403);
    await revoked.text();
  });
  it('applies frozen Bot policy to discovery and execution together', async () => {
    const f = await fixture({
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
      cindyRuntimeMcpServerNames: [],
    });
    for (const body of [list, call]) {
      const denied = await f.request(f.bound, body);
      expect(denied.status).toBe(401);
      await denied.text();
    }
    bridge!.registerSessionCtx('task', {
      agentKind: 'claude-code',
      sessionId: 'task',
      sessionInstanceId: 'instance',
      workingDir: '/remote',
      remoteHostId: 'host',
      vendorOptions: {
        [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
        cindyRuntimeMcpServerNames: ['example'],
      },
    });
    for (const body of [list, call]) {
      const allowed = await f.request(f.bound, body);
      expect(allowed.status).toBe(200);
      await allowed.text();
    }
  });
  it('keeps injection inside both the configured and frozen custom-server sets', async () => {
    await fixture();
    const gates = { collabEnabled: false, memoryEnabled: false };
    expect(selectRemoteInjectableServerNames(['example', 'cindy_ssh'], gates)).toEqual(['example']);
    expect(
      selectRemoteInjectableServerNames(['example'], { ...gates, appServerNames: [] }),
    ).toEqual([]);
    expect(
      selectRemoteInjectableServerNames(['example'], { ...gates, appServerNames: ['example'] }),
    ).toEqual(['example']);
  });
});
