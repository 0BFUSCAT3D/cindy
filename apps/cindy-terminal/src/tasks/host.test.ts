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
import { downloadRemoteFile } from '../file-transfers.js';
import { TerminalMediaTransfer } from '../media-transfer.js';
import { RemoteResourceRegistry } from '@cindy/device-link';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { TerminalPlugins } from '../plugins/host.js';
import { TerminalPluginTasks } from '../plugins/tasks.js';
import { TerminalPluginMarket } from '../plugins/market.js';
import { TerminalPluginAccount } from '../plugins/account.js';
import { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { SharedPermission } from '@cindy/im-runtime/sharedPermission';

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
  // Regression from native CI: a fresh computer has no agent binaries yet.
  // Starting the host and showing model/permission choices must precede engine
  // installation. The normal fixture has a provisioned Claude binary.
  it('starts on a fresh computer before any native engine is installed', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-no-engines-'));roots.push(root);
    const missing=path.join(root,'not-installed');
    const host=new TerminalTaskHost({profileDir:root,logger,binaryPaths:{'claude-code':missing,codex:missing,pi:missing},secretStore:{get:async()=>null,set:async()=>{},delete:async()=>{}},emit(){}});hosts.push(host);
    await host.ready;
    for(const kind of ['claude-code','codex','pi']) {
      const capabilities=await host.invoke('maker:get-capabilities',[kind]) as {permissionModes:Array<{id:string}>};
      expect(capabilities.permissionModes.length).toBeGreaterThan(0);
    }
    expect(await host.invoke('terminal:tasks:list',[])).toEqual([]);
  });
  // Integration: Desktop's settings tests do not cover the terminal's owner
  // retirement, queued atomic writes, or resolution against its actual vault.
  it('persists independent channel defaults and resolves only enabled model routes after restart', async () => {
    const { host, root, create } = await setup();
    const config = { agentKind: 'claude-code' as const, defaultModel: 'test-model', defaultPermissionMode: 'auto' as const };
    const originalGlobal = host.channelDefaults.read();
    await Promise.all([
      host.channelDefaults.update({ permissionMode: 'plan', agents: { 'claude-code': { providerId: 'fixture', model: 'test-model', effort: 'high' } } }, 'discord'),
      host.channelDefaults.update({ permissionMode: 'ask' }, 'feishu'),
    ]);
    expect(host.channelDefaults.read()).toEqual(originalGlobal);
    expect(host.channelDefaults.read('feishu').permissionMode).toBe('ask');
    expect(await host.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'test-model', providerId: 'fixture', permissionMode: 'plan' });
    const persisted = JSON.parse(await readFile(path.join(root, 'im-default-settings.json'), 'utf8'));
    expect(persisted.channels.discord.agents.pi).toBeUndefined();
    expect(() => host.channelDefaults.update({ apiKey: 'must-not-persist' }, 'discord')).toThrow();
    await host.close();
    expect(() => host.channelDefaults.update({ permissionMode: 'auto' }, 'discord')).toThrow('IM_DEFAULTS_CLOSED');
    const restarted = create(); await restarted.ready;
    expect(restarted.channelDefaults.state('discord')).toMatchObject({ isCustomized: true, value: { permissionMode: 'plan' } });
    expect(await restarted.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'test-model', providerId: 'fixture' });
    const provider = restarted.models.snapshot().providers.find(value => value.id === 'fixture')!;
    provider.runtimes['claude-code']!.models.push({ id: 'channel-fallback', name: 'Channel fallback' });
    await restarted.models.saveProvider(provider);
    await restarted.models.setDisabled({ kind: 'model', providerId: 'fixture', modelIds: ['test-model'], disabled: true }, () => {});
    expect(await restarted.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'channel-fallback', providerId: 'fixture', permissionMode: 'plan' });
    await restarted.channelDefaults.reset('discord');
    expect(restarted.channelDefaults.state('discord').isCustomized).toBe(false);
    expect(restarted.channelDefaults.read('feishu').permissionMode).toBe('ask');
  });
  // Integration / im-turn-flow: Desktop's mocked SQL tests do not cover the
  // terminal owner's atomic file or daemon retirement. Two identities claiming
  // one real task must survive restart, and a stale card must not revoke the new
  // target. Deleting the task must durably retire its takeover.
  it('restores channel takeovers after restart and retires them with their task', async () => {
    const { host, create } = await setup();
    const first = await host.invoke('maker:create-session', [{ title: 'First takeover' }]) as { id: string };
    const second = await host.invoke('maker:create-session', [{ title: 'Second takeover' }]) as { id: string };
    const discord = { channel: 'discord', botContextId: 'bot', userId: 'owner' };
    const feishu = { channel: 'feishu', botContextId: 'app', userId: 'owner' };
    await host.channelBindings.store.attach(discord, first.id, { attachedViaCardMessageId: 'card-1' });
    expect(await host.channelBindings.store.attachWithResult(feishu, first.id)).toEqual({ displaced: { identity: discord, attachedViaCardMessageId: 'card-1' } });
    await host.channelBindings.store.attach(feishu, second.id, { attachedViaCardMessageId: 'card-2' });
    await host.close();
    const resumed = create();
    await resumed.ready;
    expect(resumed.channelBindings.store.get(discord)).toBeNull();
    expect(resumed.channelBindings.store.get(feishu)).toBe(second.id);
    expect(resumed.channelBindings.store.getAttachCardMessageId(feishu)).toBe('card-2');
    expect(await resumed.channelBindings.store.detachIfTarget(feishu, first.id)).toBe(false);
    await expect(host.channelBindings.store.attach(discord, first.id)).rejects.toThrow('IM_BINDINGS_CLOSED');
    await resumed.invoke('terminal:tasks:delete', [second.id]);
    expect(resumed.channelBindings.store.get(feishu)).toBeNull();
    await resumed.close();
    const afterDeletion = create();
    await afterDeletion.ready;
    expect(afterDeletion.channelBindings.store.listAttachedTargets()).toEqual([]);
  });
  // Integration: deleting a terminal task must retire adopted channel files
  // without deleting an unrelated message still waiting for its own task.
  it('cleans adopted channel attachments through task deletion and preserves unclaimed files', async () => {
    const { host } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Channel files' }]) as { id: string };
    const staged = await host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('task attachment'), fileName: '验收.txt' });
    const unclaimed = await host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('later message'), fileName: 'later.txt' });
    const attachments: import('@cindy/im').IMAttachment[] = [{ kind: 'file', absPath: staged.absPath, originalName: '验收.txt', mimeType: 'text/plain' }];
    await host.channelFiles.adoptStagedInboundFiles(task.id, attachments);
    expect(attachments[0]!.absPath).not.toBe(staged.absPath);
    expect(await readFile(attachments[0]!.absPath, 'utf8')).toBe('task attachment');
    await host.invoke('terminal:tasks:delete', [task.id]);
    await expect(readFile(attachments[0]!.absPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unclaimed.absPath, 'utf8')).toBe('later message');
    await host.close();
    await expect(host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('old owner'), fileName: 'closed.txt' })).rejects.toThrow('TASK_HOST_CLOSED');
  });
  // Integration: channel takeover must reuse the GUI/TUI task runtime, expose
  // the same approval, and restore its saved route after that runtime closes.
  it('shares live tasks, approvals and cold channel startup with the GUI task host', async () => {
    const { host, native, nextPush } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Channel takeover' }]) as { id: string };
    const runtime = host.channelRuntime();
    const events: import('@cindy/maker-core').MakerEvent[] = [];
    const off = runtime.on(event => events.push(event));
    const session = await runtime.createSession({ id: task.id, agentKind: 'claude-code', workingDir: 'ignored-existing-task', model: 'ignored-existing-model', vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    expect(runtime.getSession(task.id)).toBe(session);
    expect(native.starts).toHaveLength(1);
    expect(native.starts[0]?.vendorOptions?.discordChatId).toBeUndefined();
    const approval = nextPush('maker:interaction-request');
    const sending = session.send({ type: 'user', content: 'permission' });
    const request = await approval as { request: import('@cindy/maker-core').InteractionRequest };
    await host.invoke('maker:resolve-interaction', [request.request.requestId, { kind: 'permission', behavior: 'allow' }]);
    await sending;
    expect(native.decisions).toHaveLength(1);
    await host.storage.update(task.id, { fastMode: true });
    await host.invoke('maker:close-session', [task.id]);
    expect(runtime.getSession(task.id)).toBeUndefined();
    expect(events.filter(event => event.type === 'session:closed')).toHaveLength(1);
    const resumed = await runtime.createSession({ id: task.id, agentKind: 'claude-code', model: 'ignored-existing-model', workingDir: 'ignored-existing-task', vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    expect(resumed).not.toBe(session);
    expect(native.starts).toHaveLength(2);
    expect(native.starts[1]).toMatchObject({ model: 'test-model', fastMode: true, vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    await host.invoke('maker:send', [task.id, { text: 'shared-again' }]);
    expect(native.starts).toHaveLength(2);
    off();
  });
  // Integration: the live CLI could not create any task once the market tools
  // were wired. The full plugin composition must precede native session startup
  // without eagerly requiring its not-yet-created incarnation.
  it('starts and sends a task with the full plugin market composition installed',async()=>{
    const {host,root,vault}=await setup();
    const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid'}),membership:()=>null,token:()=>null,refresh:async()=>{},assertCurrent:()=>{}});
    const plugins=new TerminalPlugins({root,runtimeDirectory:root,executablePath:'unused',account,assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},receive:async()=>({}),
      secrets:{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);},getSync:key=>vault.get(key)??null,setSync:(key,value)=>{vault.set(key,value);},deleteSync:key=>{vault.delete(key);},setManySync:entries=>{for(const [key,value] of Object.entries(entries))if(value===null)vault.delete(key);else vault.set(key,value);}},
      cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false,reason:'cancelled'}),writeSaveDeposit:async()=>null},
    });
    const market=new TerminalPluginMarket({root,host:plugins,account,assertCurrent:()=>{}});
    const tasks=new TerminalPluginTasks({root,runtimeDirectory:root,host:plugins,account,market,tasks:host,protectedInput:{configurePlugins:()=>{}},deposits:new DirDepositVault(),saves:new SaveDepositVault(),owner:()=>({mode:'local',dataOwnerId:'test',generation:1}),signedIn:()=>false,remoteAvailable:()=>false,locale:()=> 'en',assertCurrent:()=>{},emit:()=>{}});
    try{
      await plugins.ready;await tasks.ready;
      const task=await host.invoke('maker:create-session',[{title:'Plugin composition'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'plugin-ready'}]);
      const history=await host.invoke('local-db:messages:list',[task.id,{limit:10}]) as Array<{content:string}>;
      expect(history.map(item=>item.content)).toContain('Echo: plugin-ready');
    }finally{await host.close();tasks.close();await market.close();await plugins.close();account.close();}
  });
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

  // Integration: the terminal's direct listener used to replace IM routing.
  // A real Maker permission now reaches both surfaces, retains source metadata,
  // and accepts exactly the first response through the public remote handler.
  it.each(['terminal','channel'] as const)('shares one permission decision when %s answers first',async winner=>{
    const {host,nextPush,native}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    let shared!:SharedPermission;
    const route=await host.beginChannelInteraction(task.id,{
      route:{sessionId:task.id,turnId:'channel-turn',origin:{kind:'im',channel:'telegram'},interactionSurface:'channel-card',sourceDescription:'Test group · original message'},
      handle:async(_request,permission)=>{shared=permission!;return permission!.result;},
    });
    try{
      const requested=nextPush('maker:interaction-request');
      const running=host.invoke('maker:send',[task.id,{text:'permission'}]);
      const event=await requested as {request:{requestId:string;description:string}};
      expect(event.request.description).toContain('Test group · original message');
      if(winner==='terminal')await host.invoke('maker:resolve-interaction',[event.request.requestId,{kind:'permission',behavior:'allow'}],{source:'remote',deviceId:'controller'});
      else expect(shared.decide({kind:'permission',behavior:'allow'})).toBe(true);
      expect(shared.decide({kind:'permission',behavior:'deny'})).toBe(false);
      await running;
      expect(native.decisions).toEqual([{kind:'permission',behavior:'allow'}]);
      expect(await shared.result).toEqual(native.decisions[0]);
      expect(await host.invoke('maker:get-pending-interactions',[task.id])).toEqual([]);
      await expect(host.invoke('maker:resolve-interaction',[event.request.requestId,{kind:'permission',behavior:'deny'}])).rejects.toThrow('INTERACTION_NOT_PENDING');
    }finally{route.release();}
  });

  // Cancellation must clear the public request even though the channel/router
  // correlates the original native request ID and the terminal publishes a UUID.
  it('retires both channel and terminal permissions when their turn lease ends',async()=>{
    const {host,nextPush,native}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    let shared!:SharedPermission;
    const route=await host.beginChannelInteraction(task.id,{route:{sessionId:task.id,turnId:'cancelled-channel-turn',origin:{kind:'im',channel:'feishu'},interactionSurface:'channel-card'},handle:async(_request,permission)=>{shared=permission!;return permission!.result;}});
    const requested=nextPush('maker:interaction-request'),running=host.invoke('maker:send',[task.id,{text:'permission'}]);
    await requested;route.release('turn_terminal');await running;
    expect(native.decisions).toMatchObject([{kind:'permission',behavior:'deny',reason:'turn_terminal'}]);
    expect(shared.decide({kind:'permission',behavior:'allow'})).toBe(false);
    expect(await host.invoke('maker:get-pending-interactions',[task.id])).toEqual([]);
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
    const {host,create,root,native,pushes}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const client={invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient;
    await enqueueMessage(client,task.id,'from CLI','cli_input');
    await host.invoke('terminal:tasks:wait',[task.id,'cli_input']);
    expect(await waitForTurn(client,task.id,'cli_input')).toMatchObject({status:'completed',finalText:'Echo: from CLI'});
    // Mobile outbox settles through around-client-id and uses created events to
    // separate turns. Missing either makes an executed send appear unsent.
    expect(await host.invoke('local-db:messages:around-client-id',[task.id,'cli_input',{radius:1}])).toMatchObject([{role:'user',clientId:'cli_input'},{role:'assistant',content:'Echo: from CLI'}]);
    expect(pushes.some(push=>push.channel==='local-db:messages:created'&&(push.payload as {message?:{clientId:string}}).message?.clientId==='cli_input')).toBe(true);
    const view=await host.invoke('local-db:messages:view',[task.id,{lazyDetails:true}]);
    expect(JSON.stringify(view)).toContain('Echo: from CLI');
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
    const registry=new RemoteResourceRegistry();reopened.registerResources(registry);
    const context={controllerDeviceId:'local'};const client={protocolVersion:1,primitives:['text','actions'],locale:'zh-CN'};
    const resourceInput={name:'Resource schedule',prompt:'resource instruction',workingDir:root,agentKind:'claude-code',providerId:'fixture',model:'test-model',kind:'interval',intervalSeconds:'3600',timezone:'Asia/Shanghai',persistentSession:true};
    await registry.invoke(context,{client,collectionId:'schedules',actionId:'create',input:resourceInput});
    const page=await registry.list(context,{client,collectionId:'schedules'});
    const created=page.items.find(item=>item.display.title==='Resource schedule')!;
    expect(created).toBeTruthy();
    await registry.invoke(context,{client,collectionId:'schedules',resourceRef:created.ref,actionId:'edit',input:{name:'Edited schedule'}});
    expect(await reopened.invoke('maker:schedule:get',[created.ref.id])).toMatchObject({name:'Edited schedule',timezone:'Asia/Shanghai',intervalMs:3_600_000,persistentSession:true,model:'test-model'});
    await expect(registry.invoke(context,{client,collectionId:'schedules',actionId:'create',input:{...resourceInput,intervalSeconds:'-1'}})).rejects.toThrow('INVALID_INTERVAL');
    await registry.invoke(context,{client,collectionId:'schedules',resourceRef:created.ref,actionId:'delete'});
    expect(await reopened.invoke('maker:schedule:get',[created.ref.id])).toBeNull();
  });

  it('exports peer and OSS files without overwriting an existing destination', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-download-test-'));roots.push(root);
    const destination=path.join(root,'download.txt');
    const files={receive:async <T>(_peer:string,_url:string,makeSink:Parameters<import('../remote/files.js').TerminalFilePeerService['receive']>[2]):Promise<T>=>{
      const metadata={ticket:'fixture',size:5,mimeType:'text/plain'};
      const sink=await makeSink(metadata);
      try {await sink.write(0,Buffer.from('hello'));return await sink.finish(metadata) as T;}
      catch(error){await sink.abort();throw error;}
    }};
    const media=new TerminalMediaTransfer({ownerDir:root,getOwnerScope:()=> 'owner',getToken:async()=> 'fixture-token',getApiBaseUrl:()=> 'https://fixture.invalid',fetch:(async(url)=>String(url).includes('presign-get')?Response.json({getUrl:'https://fixture.invalid/body'}):new Response('world')) as typeof fetch});
    const options={files,media,invokeRemote:async()=>({inlineBase64:Buffer.from('world').toString('base64'),size:5,mimeType:'text/plain'})};
    expect(await downloadRemoteFile(options,['device','xdt-file:///file',destination],{source:'local'})).toMatchObject({path:destination,size:5});
    await expect(downloadRemoteFile(options,['device','xdt-file:///file',destination],{source:'local'})).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(destination,'utf8')).toBe('hello');
    await expect(media.download('fixture-key',destination)).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(destination,'utf8')).toBe('hello');
    const fallback=path.join(root,'fallback.txt');
    expect(await downloadRemoteFile({...options,files:{receive:async()=>{throw new Error('FILE_PEER_UNAVAILABLE');}}},['device','xdt-file:///file',fallback],{source:'local'})).toMatchObject({size:5});
    expect(await readFile(fallback,'utf8')).toBe('world');
  });

  it('mounts project MCP tools with vaulted credentials and managed skills in the actual task runtime', async () => {
    const {host,root,native}=await setup();const peers:McpServer[]=[];let authenticated=false;
    const upstream=createServer(async(req,res)=>{
      authenticated=req.headers.authorization==='Bearer fixture-mcp-secret';
      if(!authenticated){res.writeHead(401).end();return;}
      const server=new McpServer({name:'fixture',version:'1'});peers.push(server);
      server.registerTool('echo',{inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text:`upstream:${text}`}]}));
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
      await server.connect(transport);await transport.handleRequest(req,res);
    });
    await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const client=new McpClient({name:'test',version:'1'});
    try {
      await host.invoke('maker:mcp:custom:create',[{id:'fixture_mcp',name:'Fixture MCP',url:`http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}/mcp`,transport:'http',headers:{},scope:'project',workingDir:root},'fixture-mcp-secret']);
      await host.invoke('terminal:skills:create',[{name:'fixture_skill',description:'A test skill',body:'Use the fixture skill.',scope:'project',workingDir:root}]);
      const task=await host.invoke('maker:create-session',[{workingDir:root}]) as {id:string};
      const runtime=native.inputs.at(-1)!;
      expect((await runtime.capabilities!.getManagedSkills()).some(skill=>skill.name==='fixture_skill')).toBe(true);
      const provider=runtime.tools!.providers.find(provider=>provider.name==='fixture_mcp')!;
      const sdk=await provider.toClaudeSdkConfig!({sessionId:task.id,workingDir:root,agentKind:'claude-code'}) as {instance:McpServer};
      const [left,right]=InMemoryTransport.createLinkedPair();await sdk.instance.connect(left);await client.connect(right);
      expect((await client.listTools()).tools.map(tool=>tool.name)).toEqual(['echo']);
      expect(await client.callTool({name:'echo',arguments:{text:'hello'}})).toMatchObject({content:[{type:'text',text:'upstream:hello'}]});
      expect(authenticated).toBe(true);
      expect(await readFile(path.join(root,'capabilities.json'),'utf8')).not.toContain('fixture-mcp-secret');
      expect(JSON.stringify(await host.invoke('maker:mcp:custom:list',[]))).not.toContain('fixture-mcp-secret');
      await host.invoke('terminal:mcp:set-enabled',['fixture_mcp',false]);
      await expect(client.listTools()).rejects.toThrow();
      const other=await host.capabilities.runtime({workingDir:path.dirname(root),agentKind:'claude-code'});
      expect(other.factories).toEqual({});expect(await other.getManagedSkills()).toEqual([]);await other.close();
    }finally{await client.close();upstream.closeAllConnections();await Promise.all(peers.map(peer=>peer.close()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
  });

});
