import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { TerminalClient } from './contracts.js';

export function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (data.ok === false) {
    const error = data.error as Record<string, unknown> | undefined;
    throw new Error(typeof error?.code === 'string' ? error.code : typeof data.code === 'string' ? data.code : 'OPERATION_FAILED');
  }
  return data.ok === true && 'data' in data ? data.data : value;
}
export function modelResourceId(selection: { providerId: string; agentKind: string; model: string }): string {
  return createHash('sha256').update(JSON.stringify({ providerId: selection.providerId, agentKind: selection.agentKind, model: selection.model })).digest('hex');
}
export async function setDefaultModel(client: TerminalClient, selection: { providerId: string; agentKind: string; model: string }, device?: string): Promise<unknown> {
  if (!device) return unwrap(await client.invoke('terminal:models:default', [selection]));
  return unwrap(await client.invoke('maker:remote-resources:invoke', [{
    client: { protocolVersion: 1, primitives: ['text', 'actions'] }, collectionId: 'models', actionId: 'use-default',
    resourceRef: { collectionId: 'models', kind: 'model', id: modelResourceId(selection) }, input: {},
  }], device));
}

type TurnStatus = { sessionId: string; requestId: string; status: string; finalText?: string; errorCode?: string | null; pendingRequests?: unknown[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const messageText = (value: unknown) => typeof value === 'string' ? value : list(value).map(part => typeof part.text === 'string' ? part.text : '').join('\n');
/** Waiting never resends input and never stops the task when this client detaches. */
export async function waitForTurn(client: TerminalClient, sessionId: string, requestId: string, options: { device?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TurnStatus> {
  const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  let last: TurnStatus = { sessionId, requestId, status: 'accepted' };
  while (!options.signal?.aborted && Date.now() < deadline) {
    if (!options.device) {
      last = unwrap(await client.invoke('terminal:tasks:turn-status', [sessionId, requestId])) as TurnStatus;
      if (['completed', 'failed', 'interrupted', 'waiting'].includes(last.status)) return last;
    } else {
      // Older GUI hosts have no terminal-specific receipt endpoint. Their input
      // coordinator and persisted message history remain authoritative.
      const projection = object(unwrap(await client.invoke('maker:input:get-projection', [sessionId, { deliveryClientIds: [requestId] }], options.device)));
      const receipt = list(projection.deliveryReceipts).find(item => item.clientId === requestId);
      if (receipt?.state === 'removed') return { sessionId, requestId, status: 'interrupted', errorCode: 'INPUT_REMOVED' };
      const pending = unwrap(await client.invoke('maker:get-pending-interactions', [sessionId], options.device));
      if (Array.isArray(pending) && pending.length) return { sessionId, requestId, status: 'waiting', pendingRequests: pending };
      const queued = list(projection.pendingQueue).some(item => item.clientId === requestId || item.retrySourceClientId === requestId);
      const running = projection.turnInProgress ?? unwrap(await client.invoke('maker:session-in-turn', [sessionId], options.device));
      if (running !== true && !queued && !projection.autoResumePending && !projection.usageLimitWait) {
        const history = unwrap(await client.invoke('local-db:messages:list', [sessionId, { limit: 200 }], options.device));
        const messages = list(Array.isArray(history) ? history : object(history).messages);
        const userIndex = messages.findIndex(item => item.role === 'user' && item.clientId === requestId);
        // The shared history protocol is newest first. Correlate with this
        // request's persisted user message, never with an older assistant reply.
        const newer = userIndex < 0 ? [] : messages.slice(0, userIndex);
        const nextUserIndex = newer.findLastIndex(item => item.role === 'user');
        const turn = newer.slice(nextUserIndex + 1).reverse();
        const replies = turn.filter(item => item.role === 'assistant');
        const failed = turn.some(item => item.role === 'error' || object(item.agentMeta ?? item.agent_meta).error);
        // A host may acknowledge before the agent starts. Absence of a reply
        // cannot be reported as success, even when the busy flag is false.
        if (failed || replies.length) {
          return { sessionId, requestId, status: failed ? 'failed' : 'completed', finalText: replies.map(item => messageText(item.content)).join('\n'), ...(failed ? { errorCode: 'TURN_FAILED' } : {}) };
        }
        if (userIndex >= 0 && projection.error) {
          return { sessionId, requestId, status: 'failed', errorCode: 'TURN_FAILED' };
        }
      }
      last = { sessionId, requestId, status: 'running' };
    }
    try { await pause(400, undefined, { signal: options.signal }); } catch { break; }
  }
  return { ...last, status: 'detached', errorCode: options.signal?.aborted ? 'WAIT_CANCELLED' : 'WAIT_TIMEOUT' };
}
