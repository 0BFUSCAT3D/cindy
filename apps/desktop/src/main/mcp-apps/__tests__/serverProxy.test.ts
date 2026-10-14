import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CompleteRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  SetLevelRequestSchema,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  TaskStatusNotificationSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  CallToolResultSchema,
  ResultSchema,
  type ClientRequest,
  type CompleteRequest,
  type CompleteResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { startMockAppServer } from '../../../../scripts/mcp-apps-mock.mjs';
import { McpAppsHost } from '../host.js';
import { createAppServerProxy } from '../serverProxy.js';
import { setMcpAppsHost, registerAppServer, clearAppServerConfigs } from '../runtime.js';

const capabilities: ServerCapabilities = {
  tools: { listChanged: true },
  resources: { listChanged: true, subscribe: true },
  prompts: { listChanged: true },
  completions: {},
  logging: {},
  tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
  experimental: { 'example/custom': {} },
  extensions: { 'example/custom': {} },
};
const task = {
  taskId: 'ordinary-task',
  status: 'completed' as const,
  ttl: 60_000,
  createdAt: '2026-10-15T00:00:00Z',
  lastUpdatedAt: '2026-10-15T00:00:00Z',
};
const completionParams: CompleteRequest['params'] = {
  ref: { type: 'ref/prompt', name: 'plain' },
  argument: { name: 'value', value: 'draft' },
};
const complete =
  vi.fn<(params: CompleteRequest['params'], signal: AbortSignal) => Promise<CompleteResult>>();
const subscribed = vi.fn(),
  unsubscribed = vi.fn(),
  setLevel = vi.fn();
const upstreams: McpServer[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
let endpoint: Awaited<ReturnType<typeof startMockAppServer>>;
let emptyEndpoint: typeof endpoint;

function createPlainServer() {
  const server = new McpServer({ name: 'ordinary-mcp', version: '1' }, { capabilities });
  upstreams.push(server);
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'plain',
        inputSchema: { type: 'object' as const },
        execution: { taskSupport: 'optional' as const },
      },
      {
        name: 'app_only',
        inputSchema: { type: 'object' as const },
        _meta: { ui: { visibility: ['app'] } },
      },
    ],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
    request.params.task ? { task } : { content: [{ type: 'text' as const, text: 'plain result' }] },
  );
  server.server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
    if (extra._meta?.progressToken !== undefined)
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: extra._meta.progressToken, progress: 1, total: 1 },
      });
    return complete(request.params, extra.signal);
  });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribed(request.params);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribed(request.params);
    return {};
  });
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    setLevel(request.params);
    return {};
  });
  server.server.setRequestHandler(GetTaskRequestSchema, async () => task);
  server.server.setRequestHandler(GetTaskPayloadRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: 'task result' }],
  }));
  server.server.setRequestHandler(ListTasksRequestSchema, async () => ({ tasks: [task] }));
  server.server.setRequestHandler(CancelTaskRequestSchema, async () => ({
    ...task,
    status: 'cancelled' as const,
  }));
  server.server.fallbackRequestHandler = async (request) => ({ echo: request.params?.value });
  return server;
}

beforeAll(async () => {
  endpoint = await startMockAppServer({ createServer: createPlainServer });
  emptyEndpoint = await startMockAppServer({
    createServer: () => new McpServer({ name: 'empty', version: '1' }),
  });
});
beforeEach(() => {
  complete
    .mockReset()
    .mockImplementation(async (params) => ({
      completion: { values: [params.argument.value + '-completed'] },
    }));
  subscribed.mockClear();
  unsubscribed.mockClear();
  setLevel.mockClear();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearAppServerConfigs();
});
afterAll(async () => {
  await endpoint.close();
  await emptyEndpoint.close();
});

async function fixture(transport: 'http' | 'sse' = 'http', empty = false) {
  const source = empty ? emptyEndpoint : endpoint;
  const config = { id: 'plain', url: transport === 'http' ? source.url : source.sseUrl, transport };
  let owner: object = {};
  const writeCard = vi.fn();
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async () => {
      throw new Error('No App');
    },
    writeCard,
    authorizeTool: async () => {},
    sendMessage: async () => {},
  });
  setMcpAppsHost(host);
  registerAppServer(config.id, () => config);
  const facade = createAppServerProxy(() => config, {
    agentKind: 'codex',
    sessionId: 'task',
    workingDir: '',
  });
  const client = new Client({ name: 'model', version: '1' });
  cleanup.push(async () => {
    await client.close();
    await facade.close();
    await host.reset();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await facade.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    writeCard,
    upstream: upstreams.at(-1)!,
    changeOwner: () => {
      owner = {};
    },
  };
}

describe('ordinary MCP compatibility through the App facade', () => {
  it.each(['http', 'sse'] as const)(
    'preserves upstream capabilities, completion/progress, subscriptions and logging over %s',
    async (transport) => {
      const f = await fixture(transport);
      expect(f.client.getServerCapabilities()).toEqual(capabilities);
      const progress = vi.fn();
      let finish!: () => void;
      // SSE may deliver progress and the final response in one socket chunk. The
      // SDK handles notifications asynchronously, so keep this request in flight
      // until the model has observed progress instead of relying on socket timing.
      complete.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ completion: { values: ['draft-completed'] } });
          }),
      );
      const completion = f.client.complete(completionParams, { onprogress: progress });
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({ progress: 1, total: 1 }));
      finish();
      expect(await completion).toEqual({ completion: { values: ['draft-completed'] } });
      const updates = vi.fn(),
        logs = vi.fn();
      f.client.setNotificationHandler(ResourceUpdatedNotificationSchema, updates);
      f.client.setNotificationHandler(LoggingMessageNotificationSchema, logs);
      await f.client.subscribeResource({ uri: 'resource://plain' });
      expect(subscribed).toHaveBeenCalledWith({ uri: 'resource://plain' });
      await f.upstream.server.sendResourceUpdated({ uri: 'resource://plain' });
      await vi.waitFor(() =>
        expect(updates).toHaveBeenCalledWith(
          expect.objectContaining({ params: { uri: 'resource://plain' } }),
        ),
      );
      await f.client.unsubscribeResource({ uri: 'resource://plain' });
      expect(unsubscribed).toHaveBeenCalledWith({ uri: 'resource://plain' });
      await f.client.setLoggingLevel('info');
      expect(setLevel).toHaveBeenCalledWith({ level: 'info' });
      await f.upstream.server.notification({
        method: 'notifications/message',
        params: { level: 'info', data: 'ordinary notification' },
      });
      await vi.waitFor(() =>
        expect(logs).toHaveBeenCalledWith(
          expect.objectContaining({ params: { level: 'info', data: 'ordinary notification' } }),
        ),
      );
      expect(
        await f.client.request(
        // SDK ClientRequest enumerates standard methods; this advertised extension is custom.
        { method: 'example/echo', params: { value: 'custom' } } as unknown as ClientRequest,
          ResultSchema,
        ),
      ).toEqual({ echo: 'custom' });
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it('advertises only capabilities actually supplied by the upstream server', async () => {
    const f = await fixture('http', true);
    expect(f.client.getServerCapabilities()).toEqual({});
  });

  it('preserves task-augmented tools and task methods while enforcing model visibility', async () => {
    const f = await fixture();
    const status = vi.fn();
    f.client.setNotificationHandler(TaskStatusNotificationSchema, status);
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual(['plain']);
    expect(
      await f.client.request(
        { method: 'tools/call', params: { name: 'plain', task: { ttl: 60_000 } } },
        CreateTaskResultSchema,
      ),
    ).toEqual({ task });
    expect(
      await f.client.request(
        { method: 'tasks/get', params: { taskId: task.taskId } },
        GetTaskResultSchema,
      ),
    ).toEqual(task);
    expect(
      await f.client.request(
        { method: 'tasks/result', params: { taskId: task.taskId } },
        CallToolResultSchema,
      ),
    ).toEqual({ content: [{ type: 'text', text: 'task result' }] });
    expect(await f.client.request({ method: 'tasks/list' }, ListTasksResultSchema)).toEqual({
      tasks: [task],
    });
    expect(
      await f.client.request(
        { method: 'tasks/cancel', params: { taskId: task.taskId } },
        GetTaskResultSchema,
      ),
    ).toMatchObject({ status: 'cancelled' });
    await f.upstream.server.notification({ method: 'notifications/tasks/status', params: task });
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(expect.objectContaining({ params: task })),
    );
    await expect(
      f.client.request(
        { method: 'tools/call', params: { name: 'app_only', task: { ttl: 60_000 } } },
        CreateTaskResultSchema,
      ),
    ).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
    expect(f.writeCard).not.toHaveBeenCalled();
  });

  it.each(['owner', 'server'] as const)(
    'rejects late completion results and new calls after %s revocation',
    async (kind) => {
      const f = await fixture();
      let finish!: () => void;
      complete.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ completion: { values: ['late'] } });
          }),
      );
      const pending = f.client.complete(completionParams);
      const rejected = expect(pending).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (kind === 'owner') f.changeOwner();
      else clearAppServerConfigs();
      finish();
      await rejected;
      await expect(f.client.subscribeResource({ uri: 'resource://plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      expect(subscribed).not.toHaveBeenCalled();
    },
  );

  it('forwards cancellation to the single upstream request without replaying it', async () => {
    const f = await fixture();
    const cancelled = vi.fn();
    complete.mockImplementationOnce(
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled();
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const abort = new AbortController();
    const pending = f.client.complete(completionParams, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledOnce();
  });
});
