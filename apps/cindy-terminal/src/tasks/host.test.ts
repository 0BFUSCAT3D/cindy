import { enqueueMessage, waitForTurn } from '../client-operations.js';
import type { TerminalClient } from '../contracts.js';
import { TerminalSchedulerHost } from './scheduler.js';
import { createServer } from 'node:http';
import { createProviderProxy } from '../models/proxy.js';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAgent, type AgentEvent, type AgentSessionHandle, type InteractionDecision, type InteractionResolver, type Logger, type StartSessionOptions } from '@cindy/maker-core';
import type { TerminalSecrets } from '../contracts.js';
import { TerminalTaskHost } from './host.js';
import type { RuntimeInput } from '../models/runtime.js';
import { TerminalTaskStorage } from './storage.js';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const roots: string[] = [];
const schedulers: TerminalSchedulerHost[] = [];
const hosts: TerminalTaskHost[] = [];
afterEach(async () => { for(const scheduler of schedulers.splice(0))await scheduler.close(); for (const host of hosts.splice(0)) await host.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Native transport substitute: all task lifecycle/approval behavior remains in real Maker. */
function engine() {
  const starts: StartSessionOptions[] = [];
  const inputs: RuntimeInput[] = [];
  const decisions: InteractionDecision[] = [];
  const sent: import('@cindy/maker-core').UserMessage[] = [];
  const create = async (input: RuntimeInput) => {
    inputs.push(input);
    const agent = new ClaudeCodeAgent({ binaryPath: process.execPath, auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} }, runtimeConfig: {}, logger });
    agent.startSession = async options => {
      starts.push(options);
      let running = false;
      let ended = false;
      let resolver: InteractionResolver | undefined;
      let awaken: (() => void) | undefined;
      const events: AgentEvent[] = [];
      const emit = (event: AgentEvent) => { events.push(event); awaken?.(); };
      const handle: AgentSessionHandle = {
        id: options.resumeSessionId ?? `native-${options.sessionId}`,
        agentKind: 'claude-code', model: options.model,
        async send(message) {
          sent.push(message);
          running = true;
          emit({ type: 'status', data: { isRunning: true } });
          const text = typeof message.content === 'string' ? message.content : '';
          if (text === 'permission') {
            const decision = await resolver!({ requestId: 'native-request', kind: 'permission', toolName: 'Bash', input: { command: 'true' } });
            decisions.push(decision);
          }
          emit({ type: 'text', data: { text: `Echo: ${text}`, isFinal: true } });
          running = false;
          emit({ type: 'done', data: {} });
        },
        async steer() {},
        async abort() { running = false; emit({ type: 'done', data: {} }); },
        async close() { ended = true; running = false; awaken?.(); },
        async *events() {
          while (!ended || events.length) {
            const next = events.shift();
            if (next) yield next;
            else await new Promise<void>(resolve => { awaken = resolve; });
          }
        },
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 200000, costUsd: 0 }),
        setInteractionResolver: value => { resolver = value; },
        isTurnRunning: () => running,
      };
      return handle;
    };
    return agent;
  };
  return { create, starts, decisions, inputs, sent };
}

async function setup(native = engine()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-task-test-'));
  roots.push(root);
  const vault = new Map<string, string>();
  const secrets: TerminalSecrets = { get: async key => vault.get(key) ?? null, set: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } };
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const nextPush = (channel: string) => new Promise<unknown>(resolve => { listeners.set(channel, resolve); });
  const create = () => {
    const host = new TerminalTaskHost({ profileDir: root, secretStore: secrets, logger, binaryPaths: { 'claude-code': process.execPath }, createAgent: native.create, nativeStatus: async () => ({ authenticated: false }), emit: (channel, args) => { pushes.push({ channel, payload: args[0] }); listeners.get(channel)?.(args[0]); listeners.delete(channel); } });
    hosts.push(host);
    return host;
  };
  const host = create();
  await host.invoke('maker:provider:custom:create', [{ id: 'fixture', name: 'Fixture', auth: { method: 'apiKey' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'test-model', name: 'Test model', contextWindow: 200000 }] } } }, { 'claude-code': 'invalid-test-key-only' }]);
  await host.invoke('terminal:models:set-default', [{ agentKind: 'claude-code', providerId: 'fixture', model: 'test-model' }]);
  return { host, root, create, pushes, native, vault, nextPush };
}

describe('terminal task host', () => {
  it('persists user/assistant history and resumes the original native task after a daemon restart', async () => {
    const { host, root, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Persistent task' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'hello' }]);
    await host.storage.flush();
    const history = await host.invoke('local-db:messages:list', [task.id, { limit: 10 }]) as Array<{ role: string; content: string }>;
    expect(history.map(m => [m.role, m.content])).toEqual([['assistant', 'Echo: hello'], ['user', 'hello']]);
    const disk = await readFile(path.join(root, 'models.json'), 'utf8');
    expect(disk).not.toContain('invalid-test-key-only');
    await host.close();
    const resumed = create();
    expect(await resumed.invoke('local-db:sessions:list', [100, 'active'])).toMatchObject([{ id: task.id, title: 'Persistent task', providerId: 'fixture', isTurnRunning: false }]);
    await resumed.invoke('maker:send', [task.id, { text: 'again' }]);
    expect(native.starts.at(-1)?.resumeSessionId).toBe(native.starts[0].sessionId ? `native-${native.starts[0].sessionId}` : undefined);
    expect(native.starts.at(-1)?.providerId).toBe('fixture');
  });

  it('keeps disconnected approvals pending, rejects mismatched replies, and runs a second task', async () => {
    const { host, nextPush, native } = await setup();
    const a = await host.invoke('maker:create-session', [{ title: 'A' }]) as { id: string };
    const b = await host.invoke('maker:create-session', [{ title: 'B' }]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const running = host.invoke('maker:send', [a.id, { text: 'permission' }]);
    await requested;
    const requests = await host.invoke('maker:get-pending-interactions', [a.id]) as Array<{ request: { requestId: string } }>;
    expect(requests).toHaveLength(1);
    await expect(host.invoke('maker:resolve-interaction', [requests[0].request.requestId, { kind: 'ask_user_question', answers: {} }])).rejects.toThrow('INTERACTION_KIND_MISMATCH');
    await host.invoke('maker:send', [b.id, { text: 'independent' }]);
    expect(await host.invoke('maker:session-in-turn', [a.id])).toBe(true);
    expect(native.decisions).toEqual([]);
    await host.invoke('maker:resolve-interaction', [requests[0].request.requestId, { kind: 'permission', behavior: 'allow' }]);
    await running;
    expect(native.decisions).toEqual([{ kind: 'permission', behavior: 'allow' }]);
    expect(await host.invoke('maker:get-pending-interactions', [a.id])).toEqual([]);
  });

  it('protects local configuration and preserves prior settings on invalid route input', async () => {
    const { host } = await setup();
    await expect(host.invoke('terminal:models:reset-default', [], { source: 'remote', deviceId: 'fixture' })).rejects.toThrow('LOCAL_CONFIGURATION_REQUIRED');
    await expect(host.invoke('terminal:models:set-default', [{ agentKind: 'claude-code', providerId: 'fixture', model: 'missing' }])).rejects.toThrow('MODEL_ROUTE_UNAVAILABLE');
    expect(await host.invoke('terminal:models:get')).toMatchObject({ defaultSelection: { model: 'test-model' } });
  });

  it('durably deduplicates asynchronous submissions while an approval remains answerable', async () => {
    const { host, nextPush, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const accepted = await host.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }]);
    expect(accepted).toMatchObject({ accepted: true, requestId: 'unique-request' });
    await requested;
    expect(host.isBusy()).toBe(true);
    expect(await host.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }])).toMatchObject({ accepted: true });
    await expect(host.invoke('maker:send', [task.id, { text: 'other', clientId: 'unique-request' }])).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    const waiting = await host.invoke('terminal:tasks:turn-status', [task.id, 'unique-request']) as { status: string; pendingRequests: Array<{ requestId: string }> };
    expect(waiting.status).toBe('waiting');
    const completion = host.invoke('terminal:tasks:wait', [task.id, 'unique-request']);
    await host.invoke('maker:resolve-interaction', [waiting.pendingRequests[0].requestId, { kind: 'permission', behavior: 'allow' }]);
    expect(await completion).toMatchObject({ status: 'completed', finalText: 'Echo: permission' });
    await host.close();
    const resumed = create();
    expect(await resumed.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }])).toMatchObject({ status: 'completed' });
    expect(native.starts).toHaveLength(1);
  });

  it('runs the existing Cindy helper over an authenticated task-bound MCP bridge', async () => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const tools = native.inputs[0].tools!;
    const config = tools.providers[0].toCodexMcpConfig!({ agentKind: 'codex', workingDir: '/', sessionId: task.id })!;
    const headers = { authorization: `Bearer ${tools.env[config.bearerTokenEnvVar!]}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const init = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'terminal-test', version: '1' } } }) });
    expect(init.status).toBe(200);
    await init.text();
    const sessionId = init.headers.get('mcp-session-id')!;
    const unauthorized = await fetch(config.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    const call = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Renamed by actual MCP' } } } }) });
    const payload = await call.text();
    expect(payload).toContain('Renamed by actual MCP');
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({ title: 'Renamed by actual MCP' });
  });

  it('repairs only an uncommitted trailing history append and continues its sequence', async () => {
    const { host, root } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:send', [task.id, 'hello']);
    await host.close();
    const oldHistory = await host.storage.history(task.id, 0, 1000);
    await appendFile(path.join(root, 'tasks', task.id, 'events.jsonl'), '{"sequence":');
    const storage = new TerminalTaskStorage(path.join(root, 'tasks'));
    await storage.open();
    const next = await storage.append(task.id, { kind: 'user', message: { type: 'user', content: 'after crash' } });
    expect(next.sequence).toBe(oldHistory.records.at(-1)!.sequence + 1);
    expect((await storage.history(task.id, 0, 1000)).records.at(-1)?.message?.content).toBe('after crash');
  });
  it('serves released remote history cursors and enforces shared task author and scope', async () => {
    const { host } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const other = await host.invoke('maker:create-session', [{}]) as { id: string };
    const context = { source: 'remote' as const, deviceId: 'peer', ownerId: 'owner', assertCurrent() {}, sharedTask: { sharedTaskId: 'share', sessionId: task.id, memberId: 'member', accountId: 'account', name: 'Member' } };
    await expect(host.invoke('maker:set-model', [task.id, 'test-model'], context)).rejects.toThrow('SHARED_TASK_PERMISSION_DENIED');
    await expect(host.invoke('maker:send', [other.id, 'wrong'], context)).rejects.toThrow('SHARED_TASK_SCOPE_MISMATCH');
    await host.invoke('maker:send', [task.id, { text: 'shared message' }], context);
    await host.storage.flush();
    const historyArgs = { sessionId: task.id, workdir: null, fromMs: null, toMs: null, agentKind: null, roles: ['user', 'assistant'], includeRewound: false, limit: 1, cursor: null, order: 'asc', contentCharLimit: null };
    const first = await host.invoke('local-db:history:messages', [historyArgs], context) as { items: Array<{ role: string; agentMeta: unknown }>; nextCursor: unknown; hasMore: boolean };
    expect(first.items[0]).toMatchObject({ role: 'user', agentMeta: { sharedTaskAuthor: { memberId: 'member', accountId: 'account', displayName: 'Member' } } });
    expect(first.hasMore).toBe(true);
    const second = await host.invoke('local-db:history:messages', [{ ...historyArgs, cursor: first.nextCursor }], context) as { items: Array<{ role: string }> };
    expect(second.items.map(item => item.role)).toEqual(['assistant']);
    expect(await host.invoke('local-db:history:query', [{ tool: 'list_sessions', args: { limit: 10 } }], { source: 'remote', assertCurrent() {} })).toMatchObject({ ok: true });
    expect(await host.invoke('local-db:history:query', [{tool:'search_chat_history',args:{query:'shared message',limit:10}}])).toMatchObject({ok:true});
  });

  it('keeps custom headers in the vault and injects upstream credentials only behind the task proxy', async () => {
    const { host, root, vault } = await setup();
    let received: { path?: string; headers?: import('node:http').IncomingHttpHeaders; body?: Record<string, unknown> } = {};
    const server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chat-fixture', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'proxy result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    let proxy: Awaited<ReturnType<typeof createProviderProxy>> | undefined;
    try {
      await host.invoke('maker:provider:custom:create', [{ id: 'chatfixture', name: 'Chat', runtimes: { codex: { baseUrl: `http://127.0.0.1:${addr.port}`, wireProtocol: 'openai-chat', headers: { 'X-Private': 'secret-header-value' }, models: [{ id: 'test-model', name: 'Test' }] } } }, { codex: 'secret-key-value' }]);
      expect(await readFile(path.join(root, 'models.json'), 'utf8')).not.toMatch(/secret-header-value|secret-key-value/);
      expect([...vault.values()]).toContain('{"x-private":"secret-header-value"}');
      const { route } = await host.models.select({ agentKind: 'codex', providerId: 'chatfixture', model: 'test-model' });
      proxy = await createProviderProxy(route, 'codex', await host.models.credential('chatfixture', 'codex'), await host.models.headers('chatfixture', 'codex'));
      const body = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
      expect((await fetch(`${proxy.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body })).status).toBe(403);
      const response = await fetch(`${proxy.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.token}` }, body });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('proxy result');
      expect(received.path).toBe('/chat/completions');
      expect(received.headers).toMatchObject({ authorization: 'Bearer secret-key-value', 'x-private': 'secret-header-value' });
      expect(received.body).toMatchObject({ messages: [{ role: 'user', content: 'hello' }] });
      expect(await host.invoke('maker:provider:test-connection',[{kind:'saved',providerId:'chatfixture',agent:'codex'}])).toMatchObject({ok:true});
      await host.invoke('maker:model-disable:set',[{kind:'model',providerId:'chatfixture',modelIds:['test-model'],disabled:true}]);
      await expect(host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).rejects.toThrow('MODEL_ROUTE_UNAVAILABLE');
      await host.invoke('maker:model-disable:set',[{kind:'reset',providerId:'chatfixture'}]);
      expect((await host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).selection.model).toBe('test-model');

    } finally { await proxy?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('accepts the production queue client and preserves delayed file/media input across restart', async () => {
    const {host,create,root,native}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const client={invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient;
    await enqueueMessage(client,task.id,'from CLI','cli_input');
    await host.invoke('terminal:tasks:wait',[task.id,'cli_input']);
    expect(await waitForTurn(client,task.id,'cli_input')).toMatchObject({status:'completed',finalText:'Echo: from CLI'});
    const encoded=Buffer.from('frozen attachment').toString('base64');
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4sAAAAASUVORK5CYII=';
    await host.invoke('maker:input:enqueue',[task.id,{clientId:'delayed_input',text:'Read these',files:[{name:'note.txt',mimeType:'text/plain',base64:encoded},{name:'pixel.png',mimeType:'image/png',category:'image',base64:png}]},{sendAtMs:Date.now()+60_000}]);
    const receipt=await host.storage.submission(task.id,'delayed_input');
    expect(receipt?.status).toBe('queued');
    const blocks=receipt!.message!.content as import('@cindy/maker-core').UserContentBlock[];
    const file=blocks.find(block=>block.type==='file')! as {path:string};
    expect(await readFile(file.path,'utf8')).toBe('frozen attachment');
    const image=blocks.find(block=>block.type==='image')! as {path:string;managedUrl:string};
    expect((await host.resolveManaged(image.managedUrl,task.id)).path).toBe(image.path);
    await expect(host.resolveManaged(image.managedUrl,'unrelated')).rejects.toThrow('MEDIA_SESSION_ACCESS_DENIED');
    await host.close();const restored=create();
    const projection=await restored.invoke('maker:input:get-projection',[task.id]) as {pendingQueue:Array<{clientId:string;sendAtMs:number}>};
    expect(projection.pendingQueue).toMatchObject([{clientId:'delayed_input'}]);
    expect(native.sent).toHaveLength(1);
    expect((await readFile(path.join(root,'tasks',task.id,'requests.json'),'utf8'))).not.toContain(encoded);
    expect(await restored.invoke('maker:input:get-projection',[task.id,{deliveryClientIds:['delayed_input','missing']}])).toMatchObject({terminalTurnReceiptsVersion:1,deliveryReceipts:[{clientId:'delayed_input',state:'pending',turnStatus:'queued'},{clientId:'missing',state:'unknown'}]});
    await restored.invoke('maker:input:enqueue',[task.id,{clientId:'second_queued',text:'second'},{sendAtMs:Date.now()+60_000}]);
    await restored.invoke('maker:input:move',[task.id,'second_queued',0]);
    await restored.close();const ordered=create();
    expect(await ordered.invoke('maker:input:get-projection',[task.id])).toMatchObject({pendingQueue:[{clientId:'second_queued'},{clientId:'delayed_input'}]});
    await ordered.invoke('maker:input:remove',[task.id,'delayed_input']);
    expect(await ordered.invoke('maker:input:get-projection',[task.id,{deliveryClientIds:['delayed_input']}])).toMatchObject({deliveryReceipts:[{state:'removed',turnStatus:'interrupted',errorCode:'INPUT_REMOVED'}]});
    const latest=await ordered.invoke('local-db:messages:list',[task.id,{limit:1}]) as Array<{id:string;role:string}>;
    const previous=await ordered.invoke('local-db:messages:list',[task.id,{limit:1,before:latest[0].id}]) as Array<{id:string;role:string}>;
    expect(latest[0].role).toBe('assistant');expect(previous[0].role).toBe('user');

  });

  it('runs and resumes owner-scoped schedules through the real engine and persists script completion', async () => {
    const { host, root } = await setup();
    const scheduler = new TerminalSchedulerHost({profileDir:root,tasks:host,logger,emit(){}});schedulers.push(scheduler);
    const base = {name:'Scheduled echo',prompt:'scheduled hello',kind:'cron',cronExpr:'0 * * * *',timezone:'UTC',recurring:true,manual:true,agentKind:'claude-code',providerId:'fixture',model:'test-model',workspaceKind:'dialogue',useWorktree:false,persistentSession:true,notify:{desktop:false,feishu:false}};
    const schedule = await scheduler.invoke('maker:schedule:create',[base]) as {id:string};
    await scheduler.invoke('maker:schedule:run-now',[schedule.id]);
    const runs = await scheduler.invoke('maker:schedule:list-runs',[schedule.id]) as Array<{status:string;sessionId:string;resultText:string}>;
    expect(runs[0]).toMatchObject({status:'success'});
    expect(runs[0].resultText).toContain('scheduled hello');
    const row=await scheduler.invoke('maker:schedule:get',[schedule.id]) as {targetSessionId:string};
    expect(row.targetSessionId).toBe(runs[0].sessionId);
    const script = await scheduler.invoke('maker:schedule:create',[{...base,name:'Script',workspaceKind:'project',workingDir:root,persistentSession:false,executionMode:'script',scriptConfig:{command:process.platform==='win32'?'echo {"protocol":"cindy-script/1","type":"complete","resultText":"script ok"}':`printf '%s\n' '{"protocol":"cindy-script/1","type":"complete","resultText":"script ok"}'`,capabilities:[]}}]) as {id:string};
    await scheduler.invoke('maker:schedule:run-now',[script.id]);
    expect(await scheduler.invoke('maker:schedule:list-runs',[script.id])).toMatchObject([{status:'success',resultText:'script ok'}]);
    await scheduler.close();
    const reopened=new TerminalSchedulerHost({profileDir:root,tasks:host,logger,emit(){}});schedulers.push(reopened);
    expect(await reopened.invoke('maker:schedule:get',[schedule.id])).toMatchObject({targetSessionId:row.targetSessionId});
  });

});
