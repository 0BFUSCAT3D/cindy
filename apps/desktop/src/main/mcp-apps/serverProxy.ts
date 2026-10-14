import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { McpAppRecord } from '../../shared/mcpApps.js';
import { AppConnection, type AppServerConfig } from './connection.js';
import { appServerRevision } from './host.js';
import { getMcpAppsHost, readAppServer } from './runtime.js';
import { toolVisibleTo, uiToolUri } from './protocol.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-apps');

/** Generic MCP facade: the harness keeps its own tool approval, while Main negotiates Apps. */
export function createAppServerProxy(
  readConfig: () => AppServerConfig,
  context: McpProviderContext,
): McpServer {
  const config = readConfig();
  const host = getMcpAppsHost();
  const owner = host.captureOwner();
  const connection = new AppConnection(config);
  const connectionId = host.registerConnection(connection, owner);
  const assertCurrent = () => {
    host.assertOwner(owner);
    const current = readAppServer(config.id);
    if (!current || appServerRevision(current) !== appServerRevision(config))
      throw new Error('MCP_APP_SERVER_CHANGED');
  };
  const server = new McpServer(
    { name: config.id, version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} },
    },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    assertCurrent();
    return { tools: (await connection.tools()).filter((tool) => toolVisibleTo(tool, 'model')) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    assertCurrent();
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
    assertCurrent();
    return (await connection.getClient()).readResource(request.params);
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    assertCurrent();
    return (await connection.getClient()).listResources(request.params);
  });
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    assertCurrent();
    return (await connection.getClient()).listResourceTemplates(request.params);
  });
  server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    assertCurrent();
    return (await connection.getClient()).listPrompts(request.params);
  });
  server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    assertCurrent();
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
