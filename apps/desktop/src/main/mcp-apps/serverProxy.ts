import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type CallToolResult,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { McpAppRecord } from '../../shared/mcpApps.js';
import { AppConnection, type AppServerConfig } from './connection.js';
import { appServerRevision } from './host.js';
import { getMcpAppsHost, readAppServer } from './runtime.js';
import { toolVisibleTo, uiToolUri } from './protocol.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-apps');

/** Preserve the SDK handshake while attaching authenticated upstream instructions. */
class AppProxyServer extends McpServer {
  constructor(
    name: string,
    private readonly readInstructions: () => Promise<string | undefined>,
  ) {
    super(
      { name, version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: {},
        },
      },
    );
  }

  override connect(transport: Transport): Promise<void> {
    const initializing = new Set<RequestId>();
    const wrapped: Transport = {
      get sessionId() {
        return transport.sessionId;
      },
      setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
      start: async () => {
        const onmessage = transport.onmessage;
        const onerror = transport.onerror;
        const onclose = transport.onclose;
        transport.onmessage = (message, extra) => {
          if (isJSONRPCRequest(message) && message.method === 'initialize')
            initializing.add(message.id);
          onmessage?.(message, extra);
          wrapped.onmessage?.(message, extra);
        };
        transport.onerror = (error) => {
          onerror?.(error);
          wrapped.onerror?.(error);
        };
        transport.onclose = () => {
          initializing.clear();
          onclose?.();
          wrapped.onclose?.();
        };
        await transport.start();
      },
      send: async (message, options?: TransportSendOptions) => {
        if (isJSONRPCResultResponse(message) && initializing.delete(message.id)) {
          try {
            const instructions = await this.readInstructions();
            if (instructions !== undefined)
              message = { ...message, result: { ...message.result, instructions } };
          } catch {
            // A failed response send is only reported out of band by the SDK.
            // Return an initialize error instead of leaving the client waiting.
            message = {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: ErrorCode.InternalError, message: 'MCP_APP_INITIALIZE_FAILED' },
            };
          }
        } else if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
          initializing.delete(message.id);
        }
        await transport.send(message, options);
      },
      close: () => transport.close(),
    };
    return super.connect(wrapped);
  }
}

/** Generic MCP facade: the harness keeps its own tool approval, while Main negotiates Apps. */
export function createAppServerProxy(
  readConfig: () => AppServerConfig,
  context: McpProviderContext,
): McpServer {
  const config = readConfig();
  const host = getMcpAppsHost();
  const owner = host.captureOwner();
  const connection = new AppConnection(config);
  const assertCurrent = () => {
    host.assertOwner(owner);
    const current = readAppServer(config.id);
    if (!current || appServerRevision(current) !== appServerRevision(config))
      throw new Error('MCP_APP_SERVER_CHANGED');
  };
  // Bridge factories are created eagerly, but unused proxies must not retain a Host slot.
  const registerOnUse = () => {
    assertCurrent();
    return host.registerConnection(connection, owner);
  };
  const server = new AppProxyServer(config.id, async () => {
    registerOnUse();
    const client = await connection.getClient();
    assertCurrent();
    return client.getInstructions();
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    registerOnUse();
    return { tools: (await connection.tools()).filter((tool) => toolVisibleTo(tool, 'model')) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const connectionId = registerOnUse();
    const tool = (await connection.tools()).find(
      (candidate) => candidate.name === request.params.name,
    );
    extra.signal.throwIfAborted();
    if (!tool || !toolVisibleTo(tool, 'model')) throw new Error('MCP_APP_TOOL_NOT_VISIBLE');
    const active = context.getSessionContext?.() ?? context;
    const uri = uiToolUri(tool);
    const sessionId = active.sessionId;
    const clientId = `mcp-app:${randomUUID()}`;
    let record: McpAppRecord | undefined;
    if (uri && sessionId) {
      record = {
        version: 1,
        serverId: config.id,
        serverRevision: appServerRevision(config),
        resourceUri: uri,
        tool,
        arguments: request.params.arguments ?? {},
        connectionId,
      } as McpAppRecord;
      // UI persistence failure must not prevent or change a tool's actual outcome.
      try {
        await host.updateResult(sessionId, clientId, record, owner);
      } catch {
        log.warn('MCP App card could not be stored');
        record = undefined;
      }
    }
    assertCurrent();
    let result: CallToolResult;
    try {
      extra.signal.throwIfAborted();
      result = (await (
        await connection.getClient()
      ).callTool(request.params, CallToolResultSchema, { signal: extra.signal })) as CallToolResult;
    } catch (error) {
      if (record && sessionId) {
        try {
          await host.updateResult(
            sessionId,
            clientId,
            extra.signal.aborted
              ? { ...record, cancelled: 'Tool execution cancelled' }
              : {
                  ...record,
                  result: {
                    isError: true,
                    content: [{ type: 'text', text: 'MCP App tool execution failed' }],
                  },
                },
            owner,
          );
        } catch {
          log.warn('MCP App failure card could not be stored');
        }
      }
      throw error;
    }
    if (record && sessionId) {
      try {
        await host.updateResult(sessionId, clientId, { ...record, result }, owner);
      } catch {
        log.warn('MCP App result card could not be stored');
      }
    }
    const modelResult = { ...result };
    delete modelResult._meta;
    return modelResult;
  });
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    registerOnUse();
    return (await connection.getClient()).readResource(request.params);
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    registerOnUse();
    return (await connection.getClient()).listResources(request.params);
  });
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    registerOnUse();
    return (await connection.getClient()).listResourceTemplates(request.params);
  });
  server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    registerOnUse();
    return (await connection.getClient()).listPrompts(request.params);
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    registerOnUse();
    return (await connection.getClient()).getPrompt(request.params);
  });
  const unlisten = connection.listen((message) => {
    try {
      assertCurrent();
    } catch {
      return;
    }
    void server.server.notification(message).catch(() => {});
  });
  server.server.onclose = () => {
    unlisten();
    void host.releaseConnection(connection).catch(() => {});
  };
  return server;
}
