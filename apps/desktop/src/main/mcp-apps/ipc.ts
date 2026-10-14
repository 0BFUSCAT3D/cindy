import { ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { InteractionRequest, InteractionDecision } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { createMessage, broadcastMessageRow } from '../localDb/ipc/messages.js';
import { messageToCamel } from '../localDb/mapper.js';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { McpAppsHost, type McpAppsHostDeps } from './host.js';
import { readAppServer, setMcpAppsHost } from './runtime.js';
import { MCP_APPS_INVOKE, parseMcpAppRecord } from '../../shared/mcpApps.js';
import { handleMcpAppOperation } from './operations.js';
import {
  supplyMcpAppDocument,
  removeMcpAppDocument,
  mountRemoteAppDocument,
  unmountRemoteAppDocument,
  assertMcpAppDocumentCaller,
} from './sandboxProtocol.js';

export function registerMcpAppsIpc(
  send: McpAppsHostDeps['sendMessage'],
  request: (
    sessionId: string,
    input: InteractionRequest,
    signal: AbortSignal,
  ) => Promise<InteractionDecision>,
): void {
  const currentOwner = () => getCurrentDbClientSnapshot() ?? undefined;
  const assertSession = async (sessionId: string) => {
    const owner = currentOwner();
    if (!owner) throw new Error('MCP_APP_OWNER_UNAVAILABLE');
    const [session] = await owner.client.drizzle
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (currentOwner() !== owner || !session || session.status !== 'active')
      throw new Error('MCP_APP_SESSION_UNAVAILABLE');
    return { owner, session };
  };
  const host = new McpAppsHost({
    owner: currentOwner,
    config: readAppServer,
    readCard: async (sessionId, clientId) => {
      const { owner } = await assertSession(sessionId);
      const [row] = await owner.client.drizzle
        .select({ content: messages.content, meta: messages.agentMeta })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.clientId, clientId),
            eq(messages.role, 'assistant'),
            isNull(messages.rewindAt),
            sql`EXISTS (SELECT 1 FROM sessions WHERE sessions.id = ${sessionId} AND sessions.status = 'active' AND (sessions.cleared_at IS NULL OR ${messages.createdAt} > sessions.cleared_at))`,
          ),
        )
        .limit(1);
      if (currentOwner() !== owner || !row) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      const meta = row.meta ? JSON.parse(row.meta) : null;
      const record = parseMcpAppRecord(row.content ? JSON.parse(row.content) : null);
      if (!record || meta?.mcpApp !== true) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return record;
    },
    writeCard: async (sessionId, clientId, record) => {
      const { owner, session } = await assertSession(sessionId);
      const scope = captureDataOwnerBroadcastScope();
      const [row] = await owner.client.drizzle
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId)))
        .limit(1);
      if (currentOwner() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
      if (row) {
        if (row.rewindAt || (session.clearedAt && row.createdAt <= session.clearedAt))
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        const existing = parseMcpAppRecord(row.content ? JSON.parse(row.content) : null);
        const meta = row.agentMeta ? JSON.parse(row.agentMeta) : null;
        if (
          row.role !== 'assistant' ||
          meta?.mcpApp !== true ||
          !existing ||
          existing.serverRevision !== record.serverRevision
        )
          throw new Error('MCP_APP_CARD_UNAVAILABLE');
        const updated = await owner.client.drizzle
          .update(messages)
          .set({ content: JSON.stringify({ mcpApp: record }) })
          .where(
            and(
              eq(messages.id, row.id),
              isNull(messages.rewindAt),
              sql`EXISTS (SELECT 1 FROM sessions WHERE sessions.id = ${sessionId} AND sessions.status = 'active' AND (sessions.cleared_at IS NULL OR ${messages.createdAt} > sessions.cleared_at))`,
            ),
          )
          .returning();
        if (currentOwner() !== owner || !updated[0]) throw new Error('MCP_APP_CARD_UNAVAILABLE');
        broadcastMessageRow(sessionId, messageToCamel(updated[0]), scope);
      } else {
        await createMessage(
          sessionId,
          { clientId, role: 'assistant', content: { mcpApp: record }, agentMeta: { mcpApp: true } },
          {
            broadcastOwnerScope: scope,
            beforePublish: async () => {
              const latest = await assertSession(sessionId);
              if (latest.owner !== owner || latest.session.clearedAt !== session.clearedAt)
                throw new Error('MCP_APP_CARD_UNAVAILABLE');
            },
          },
        );
      }
    },
    authorizeTool: async (sessionId, tool, args, signal) => {
      const { session } = await assertSession(sessionId);
      if (session.permissionMode === 'bypassPermissions') return;
      const decision = await request(
        sessionId,
        {
          kind: 'permission',
          requestId: randomUUID(),
          toolName: `MCP App: ${tool.name}`,
          title: tool.title ?? tool.name,
          description: tool.description,
          input: args,
        },
        signal,
      );
      if (decision.kind !== 'permission' || decision.behavior !== 'allow')
        throw new Error('MCP_APP_TOOL_DENIED');
    },
    sendMessage: send,
    disposeDocument: removeMcpAppDocument,
    audit: (method) => createLogger('mcp-apps').debug('App request', { method }),
  });
  setMcpAppsHost(host);
  ipcMain.removeHandler(MCP_APPS_INVOKE);
  ipcMain.handle(MCP_APPS_INVOKE, async (event, sessionId: unknown, raw: unknown) => {
    const remote = getDeviceLinkInvokeContext();
    if (remote?.sharedTask) throwIpcError('PRECONDITION_FAILED', 'MCP_APP_OWNER_ONLY');
    if (!remote) assertTrustedAppRendererEvent(event);
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'MCP_APP_INVALID_REQUEST');
    const caller = remote ? `device:${remote.controllerDeviceId}` : `renderer:${event.sender.id}`;
    try {
      return await handleMcpAppOperation(
        host,
        caller,
        sessionId,
        raw,
        remote
          ? undefined
          : {
              supply: supplyMcpAppDocument,
              mount: mountRemoteAppDocument,
              unmount: unmountRemoteAppDocument,
              assertCaller: assertMcpAppDocumentCaller,
              openLink: (url) => shell.openExternal(url),
            },
      );
    } catch (error) {
      const code =
        error instanceof Error && /^MCP_APP_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'MCP_APP_REQUEST_FAILED';
      throwIpcError('PRECONDITION_FAILED', code);
    }
  });
}
