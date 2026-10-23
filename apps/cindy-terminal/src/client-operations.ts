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
  const descriptor={protocolVersion:1,primitives:['text','actions']};
  let collections: Record<string,unknown>[]=[];
  try{const manifest=object(unwrap(await client.invoke('maker:remote-resources:manifest',[{client:descriptor}],device)));collections=list(manifest.collections);}
  catch(error){if(!(error instanceof Error)||!['CHANNEL_NOT_ALLOWED','UNSUPPORTED_CHANNEL'].includes(error.message))throw error;}
  if(collections.some(item=>item.id==='models'))await client.invoke('maker:remote-resources:invoke', [{
    client: descriptor, collectionId: 'models', actionId: 'use-default',
    resourceRef: { collectionId: 'models', kind: 'model', id: modelResourceId(selection) }, input: {},
  }], device).then(unwrap);
  // Existing GUI hosts keep draft preferences in their renderer. Retain this
  // controller's selection for that host without inventing a remote setter.
  return unwrap(await client.invoke('terminal:models:target-default',[device,selection]));
}

type TurnStatus = { sessionId: string; requestId: string; status: string; finalText?: string; errorCode?: string | null; pendingRequests?: unknown[] };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const messageText = (value: unknown) => typeof value === 'string' ? value : list(value).map(part => typeof part.text === 'string' ? part.text : '').join('\n');
/** The existing Desktop/Mobile queue contract also carries the durable user-row
 * identity. Sending a plain {text} object to maker:send is not that contract. */
export async function enqueueMessage(client: TerminalClient, sessionId: string, text: string, requestId: string, device?: string,
  options: { files?: Array<{path:string;name:string}>; sendAtMs?: number } = {}): Promise<unknown> {
  const session = object(unwrap(await client.invoke('local-db:sessions:get', [sessionId], device)));
  const rawKind = session.agentKind ?? session.agent_kind;
  const agentKind = rawKind === 'cc' ? 'claude-code' : rawKind;
  if (!['pi', 'codex', 'claude-code'].includes(String(agentKind))) throw new Error('INVALID_SESSION_ENGINE');
  const workingDir = session.workDir ?? session.workingDir ?? session.work_dir;
  const providerId = session.providerId ?? session.provider_id;
  const files=[];
  for(const file of options.files??[]){
    if(device){const uploaded=object(unwrap(await client.invoke('terminal:attachments:upload',[file.path])));if(typeof uploaded.reference!=='string')throw new Error('ATTACHMENT_UPLOAD_FAILED');files.push({...file,path:uploaded.reference});}
    else files.push(file);
  }
  const item = {
    clientId: requestId, text, persistedContent: files.length?JSON.stringify({text,files}):text, durableDelivery: true,files,
    model: session.model, workingDir, permissionMode: session.permissionMode ?? session.permission_mode,
    createOpts: { agentKind, model: session.model, workingDir, providerId },
    chatMessage: { clientId: requestId, role: 'user', content: text, isStreaming: false, createdAt: new Date().toISOString() },
  };
  return unwrap(await client.invoke('maker:input:enqueue', [sessionId, item,options.sendAtMs===undefined?{}:{sendAtMs:options.sendAtMs}], device));
}

export async function connectedModels(client: TerminalClient, device?: string): Promise<Array<{ providerId: string; agentKind: string; model: string; label: string }>> {
  const raw = unwrap(await client.invoke('maker:provider:list', [], device));
  const choices=list(Array.isArray(raw) ? raw : object(raw).providers).filter(provider => provider.connected).flatMap(provider =>
    Object.entries(object(provider.models)).flatMap(([agentKind, models]) => list(models).filter(model=>!model.disabled).map(model => ({
      providerId: String(provider.id), agentKind, model: String(model.id),
      label: `${String(model.name ?? model.id)} · ${String(provider.name ?? provider.id)} · ${agentKind}`,
    }))),
  );
  const preference=device?object(unwrap(await client.invoke('terminal:models:target-default',[device]))):object(object(unwrap(await client.invoke('terminal:models:get'))).defaultSelection);
  return choices.sort((a,b)=>Number(b.providerId===preference.providerId&&b.agentKind===preference.agentKind&&b.model===preference.model)-Number(a.providerId===preference.providerId&&a.agentKind===preference.agentKind&&a.model===preference.model));
}
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
      if(projection.terminalTurnReceiptsVersion===1&&receipt&&['completed','failed','interrupted','waiting'].includes(String(receipt.turnStatus))){
        return {sessionId,requestId,status:String(receipt.turnStatus),finalText:typeof receipt.finalText==='string'?receipt.finalText:undefined,errorCode:typeof receipt.errorCode==='string'?receipt.errorCode:undefined,pendingRequests:Array.isArray(receipt.pendingRequests)?receipt.pendingRequests:undefined};
      }
      if (receipt?.state === 'removed') return { sessionId, requestId, status: 'interrupted', errorCode: 'INPUT_REMOVED' };
      const queued = list(projection.pendingQueue).some(item => item.clientId === requestId || item.retrySourceClientId === requestId);
      const pending = !queued?unwrap(await client.invoke('maker:get-pending-interactions', [sessionId], options.device)):[];
      if (Array.isArray(pending) && pending.length) return { sessionId, requestId, status: 'waiting', pendingRequests: pending };
      const running = projection.turnInProgress ?? unwrap(await client.invoke('maker:session-in-turn', [sessionId], options.device));
      if (running !== true && !queued && !projection.autoResumePending && !projection.usageLimitWait) {
        const messages:Record<string,unknown>[]=[];
        let before: string|undefined;
        // A long tool run can put its user row beyond the newest history page.
        // Follow the host cursor; stop on unsupported/repeated cursors.
        while(!options.signal?.aborted&&Date.now()<deadline){
          const history=unwrap(await client.invoke('local-db:messages:list',[sessionId,{limit:200,...(before?{before}:{})}],options.device));
          const page=list(Array.isArray(history)?history:object(history).messages);
          const seen=new Set(messages.map(message=>message.id));
          const fresh=page.filter(message=>!seen.has(message.id));messages.push(...fresh);
          if(fresh.some(item=>item.role==='user'&&item.clientId===requestId)||fresh.length<200)break;
          const cursor=fresh.at(-1)?.id;if(typeof cursor!=='string'||cursor===before)break;before=cursor;
        }
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
