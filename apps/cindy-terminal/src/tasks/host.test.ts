import { createTerminalWorktrees } from '../worktrees/host.js';
import { registerWorktreeResources } from '../worktrees/resources.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TerminalPluginSessions } from '../plugins/sessions.js';
import { registerPluginResources } from '../plugins/resources.js';
import { runResourceCommand } from '../resource-commands.js';
import { encodeCatalogModelPin } from '@cindy/model-providers/catalogModelPin';
import { enqueueMessage, waitForTurn } from '../client-operations.js';
import type { TerminalClient } from '../contracts.js';
import { TerminalSchedulerHost } from './scheduler.js';
import { createServer } from 'node:http';
import { createProviderProxy } from '../models/proxy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '../platform.js';
import { TerminalImBindings } from '../im/bindings.js';
import { TerminalImConnections } from '../im/connections.js';
import { registerImResources } from '../im/resources.js';
import { TerminalGroupWindows } from '../im/group-window.js';
import Database from 'better-sqlite3';
import { GROUP_WINDOW_SCHEMA_SQL } from '../im/group-window-schema.js';
import { TerminalConfiguration } from '../configuration.js';
import { TerminalProtectedInput } from '../protected-input.js';
import { TerminalSecretStore } from '../secrets.js';
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAgent, CodexAgent, PiAgent, type AgentEvent, type AgentSessionHandle, type InteractionDecision, type InteractionResolver, type Logger, type StartSessionOptions } from '@cindy/maker-core';
import type { TerminalSecrets } from '../contracts.js';
import { TerminalTaskHost } from './host.js';
import { rebuildQueuedOrcaLeadMessage } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
import type { RuntimeInput } from '../models/runtime.js';
import { TerminalTaskStorage } from './storage.js';
import { downloadRemoteFile } from '../file-transfers.js';
import { TerminalMediaTransfer } from '../media-transfer.js';
import { RemoteResourceRegistry, REMOTE_AGENT_CHANNEL } from '@cindy/device-link';
import { TerminalRemoteAgentService } from '../remote/agent.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { TerminalPlugins } from '../plugins/host.js';
import { TerminalPluginTasks } from '../plugins/tasks.js';
import { TerminalCompanionHost } from '../remote/companions/host.js';
import { registerCompanionResources } from '../remote/companions/resources.js';
import { TerminalKnowledge } from '../knowledge.js';
import { TerminalPluginMarket } from '../plugins/market.js';
import { TerminalPluginAccount } from '../plugins/account.js';
import { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { SharedPermission } from '@cindy/im-runtime/sharedPermission';
import { createTurnRunner } from '@cindy/im-runtime/turnRunner';
import { withAutoReviewContext, AUTO_REVIEW_USER_INTENT, type AutoReviewRequest, type SendOptions } from '@cindy/maker-core';
import { createSlashHandlers } from '@cindy/im-runtime/slashCommands';
import { createCardBuilders } from '@cindy/im-runtime/cardBuilders';
import type { ImChannelAdapter } from '@cindy/im-runtime/types';
import type { TextChannelIM, ImFinalOutput, RichChannelIM, IMMessageEvent, IMCardActionEvent, InteractiveCardSpec } from '@cindy/im';
import { ui as wechatUi } from '@cindy/im-runtime/channels/wechat/uiText';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const roots: string[] = [];
const schedulers: TerminalSchedulerHost[] = [];
const hosts: TerminalTaskHost[] = [];
afterEach(async () => { for(const scheduler of schedulers.splice(0))await scheduler.close(); for (const host of hosts.splice(0)) await host.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Native transport substitute: all task lifecycle/approval behavior remains in real Maker. */
function engine(beforeStart?: (input: RuntimeInput, options: StartSessionOptions) => Promise<void>, beforeSend?: (input: RuntimeInput, options: StartSessionOptions) => Promise<void>) {
  const starts: StartSessionOptions[] = [];
  const inputs: RuntimeInput[] = [];
  const decisions: InteractionDecision[] = [];
  const permissionModes: import('@cindy/maker-core').PermissionMode[] = [];
  const title = { reply: async () => '"Server task"' };
  const titleRequests: Array<{ prompt: string; options?: import('@cindy/maker-core').OneShotOptions }> = [];
  const sent: import('@cindy/maker-core').UserMessage[] = [];
  const sentTaskIds: string[] = [];
  const steered: import('@cindy/maker-core').UserMessage[] = [];
  const steer = { reply: async () => {} };
  const held = new Map<string, () => void>();
  const heldListeners = new Map<string, () => void>();
  const sends: Array<SendOptions|undefined> = [];
  const resumeFailures = new Set<string>();
  const overflowed = new Set<string>();
  const usageByModel = new Map<string, { contextTokens: number; contextWindow: number }>();
  const create = async (input: RuntimeInput) => {
    inputs.push(input);
    const Agent = { 'claude-code': ClaudeCodeAgent, codex: CodexAgent, pi: PiAgent }[input.selection.agentKind];
    const agent = new Agent({ binaryPath: process.execPath, auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} }, runtimeConfig: {}, logger });
    agent.oneShot = async (prompt, options) => { titleRequests.push({ prompt, options }); return title.reply(); };
    agent.startSession = async options => {
      await beforeStart?.(input, options);
      starts.push(options);
      if (options.resumeSessionId && resumeFailures.delete(options.resumeSessionId)) throw new Error('fixture native transcript expired');
      let running = false;
      let silentForever = false;
      let ended = false;
      let resolver: InteractionResolver | undefined;
      let awaken: (() => void) | undefined;
      const events: AgentEvent[] = [];
      const emit = (event: AgentEvent) => { events.push(event); awaken?.(); };
      const handle: AgentSessionHandle = {
        id: options.resumeSessionId ?? `${input.selection.agentKind === 'claude-code' ? 'native' : `${input.selection.agentKind}-native`}-${options.sessionId}`,
        agentKind: input.selection.agentKind, model: options.model,
        async send(message,sendOptions) {
          sent.push(message);
          sentTaskIds.push(input.taskId);
          sends.push(sendOptions);
          running = true;
          emit({ type: 'status', data: { isRunning: true } });
          await beforeSend?.(input, options);
          const text = typeof message.content === 'string' ? message.content : '';
          if (text === 'wait-for-steer') {
            held.set(input.taskId, () => { running = false; emit({ type: 'done', data: {} }); held.delete(input.taskId); });
            heldListeners.get(input.taskId)?.(); heldListeners.delete(input.taskId);
            return;
          }
          if (text === 'silent-once' || text === 'silent-loop' || silentForever) {
            silentForever ||= text === 'silent-loop';
            running = false;
            emit({ type: 'done', data: { silentStop: true } });
            return;
          }
          if (text.includes('context-overflow-fixture') || text.includes('overflow-once') && !overflowed.has(input.taskId) || text.includes('overflow-after-write')) {
            overflowed.add(input.taskId);
            if (text.includes('overflow-after-write')) {
              await writeFile(path.join(options.workingDir, 'effect.txt'), 'completed once');
              emit({ type: 'tool_use', data: { toolName: 'Write', input: { file_path: 'effect.txt' } } });
            }
            running = false;
            emit({ type: 'error', data: { reason: 'context-overflow', message: 'maximum context length exceeded', isTerminal: true } });
            return;
          }
          if (text === 'permission') {
            const decision = await resolver!({ requestId: 'native-request', kind: 'permission', toolName: 'Bash', input: { command: 'true' } });
            decisions.push(decision);
          }
          if (text === 'edit-fixture') {
            await input.turnChangeCapture!.beforeKnownFileWrite({ sessionId: options.sessionId!, provider: 'claude-code', cwd: options.workingDir, targetPath: 'revision.txt' });
            await writeFile(path.join(options.workingDir, 'revision.txt'), 'after\n');
          }
          emit({ type: 'text', data: { text: `Echo: ${text}`, isFinal: true } });
          running = false;
          emit({ type: 'done', data: {} });
        },
        async steer(message) { steered.push(message); await steer.reply(); },
        async abort() { running = false; emit({ type: 'done', data: {} }); },
        async close() { ended = true; running = false; awaken?.(); },
        async *events() {
          while (!ended || events.length) {
            const next = events.shift();
            if (next) yield next;
            else await new Promise<void>(resolve => { awaken = resolve; });
          }
        },
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: input.route.model.contextWindow, costUsd: 0, ...usageByModel.get(options.model!) }),
        setInteractionResolver: value => { resolver = value; },
        async setPermissionMode(mode) { permissionModes.push(mode); },
        async setVendorOptions(patch) { options.vendorOptions = { ...options.vendorOptions, ...patch }; },
        getPlanMode: () => options.planMode ?? false,
        isTurnRunning: () => running,
      };
      return handle;
    };
    return agent;
  };
  return { create, starts, decisions, inputs, sent, sends, permissionModes, title, titleRequests, resumeFailures, usageByModel,
    steered, steer, sentFor: (id: string) => sent.filter((_message, index) => sentTaskIds[index] === id), finishHeld: (id: string) => held.get(id)?.(),
    waitForHeld: (id: string) => held.has(id) ? Promise.resolve() : new Promise<void>(resolve => heldListeners.set(id, resolve)),
  };
}

async function setup(native = engine(), overrides: Partial<ConstructorParameters<typeof TerminalTaskHost>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-task-test-'));
  roots.push(root);
  const vault = new Map<string, string>();
  const secrets: TerminalSecrets = { get: async key => vault.get(key) ?? null, set: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } };
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const nextPush = (channel: string) => new Promise<unknown>(resolve => { listeners.set(channel, resolve); });
  const create = () => {
    const host = new TerminalTaskHost({ profileDir: root, secretStore: secrets, logger, binaryPaths: { 'claude-code': process.execPath, codex: process.execPath, pi: process.execPath }, createAgent: native.create, nativeStatus: async () => ({ authenticated: false }), ...overrides, emit: (channel, args) => { pushes.push({ channel, payload: args[0] }); listeners.get(channel)?.(args[0]); listeners.delete(channel); } });
    hosts.push(host);
    return host;
  };
  const host = create();
  await host.invoke('maker:provider:custom:create', [{ id: 'fixture', name: 'Fixture', auth: { method: 'apiKey' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'test-model', name: 'Test model', contextWindow: 200000 }] } } }, { 'claude-code': 'invalid-test-key-only' }]);
  await host.invoke('terminal:models:set-default', [{ agentKind: 'claude-code', providerId: 'fixture', model: 'test-model' }]);
  return { host, root, create, pushes, native, vault, nextPush };
}

// Real auxiliary HTTP route, shared by the channel/title regressions.
async function auxiliaryFixture(host: TerminalTaskHost, reply: () => Promise<string>) {
  const requests: Array<{model: string; messages: Array<{content: string}>}> = [];
  const api = createServer(async (req, res) => {
    let body=''; for await (const chunk of req) body+=chunk;
    requests.push(JSON.parse(body));
    const text=await reply();
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:text}}]}));
  });
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
  const close=async()=>{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));};
  try {
    await host.models.saveProvider({id:'auxiliary-fixture',name:'Auxiliary fixture',auth:{method:'apiKey'},runtimes:{codex:{baseUrl:`http://127.0.0.1:${(api.address() as {port:number}).port}`,wireProtocol:'openai-chat',models:[{id:'test-utility',name:'Utility'}]}}},{codex:'fake-auxiliary-key'},true);
    await host.utility.update({models:[encodeCatalogModelPin({providerId:'auxiliary-fixture',agentKind:'codex',model:'test-utility'})]});
    return {requests,close};
  } catch(error) { await close();throw error; }
}

describe('terminal task host', () => {
  // Integration: GUI precreation must be claimed by the same persisted task,
  // cancellation must fence late creation, and native runtime closure must
  // precede the actual encrypted worktree recycler.
  it('claims GUI worktree precreation and restores it after native task archival', async () => {
    const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'terminal-worktree-task-'))); roots.push(profile);
    const owner = path.join(profile, 'owners', 'b'.repeat(32));
    const f = await setup(engine(), { profileDir: owner });
    const worktrees = await createTerminalWorktrees({ profile, root: owner, tasks: f.host.storage, logger, guard() {},
      appDataRoot: path.join(profile, 'app-data'), readSessionTransfer: async () => undefined,
      secrets: { getSync: key => f.vault.get(key) ?? null, setSync: (key, value) => { f.vault.set(key, value); } },
    });
    await f.host.connectWorktrees(worktrees);
    const repo = path.join(profile, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(profile, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' } });
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Worktree Test'); await git('config', 'user.email', 'worktree-test@localhost');
    await writeFile(path.join(repo, 'file.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'fixture');
    const id = 'gui-precreated';
    const remote = { source: 'remote' as const, ownerId: 'owner', deviceId: 'controller', assertCurrent() {} };
    const created = await f.host.invoke('worktree:create', [{ sessionId: id, baseRepo: repo, name: 'gui', sourceBranch: 'main', recoveryKey: 'gui-recovery-key-0001' }], remote) as { ok: boolean; meta: { path: string } };
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const task = await f.host.invoke('maker:create-session', [{ id, workingDir: created.meta.path }], remote) as { sessionId: string };
    expect(task.sessionId).toBe(id);
    expect(f.native.starts.at(-1)?.workingDir).toBe(created.meta.path);
    expect(await f.host.invoke('local-db:sessions:get', [id])).toMatchObject({ id, worktreePath: created.meta.path });
    await expect(f.host.invoke('worktree:cancel-precreated', [{ sessionId: id, recoveryKey: 'gui-recovery-key-0001' }], remote)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await writeFile(path.join(created.meta.path, 'file.txt'), 'retained user changes');
    const recycled = f.nextPush('worktree:changed');
    await f.host.invoke('local-db:sessions:patch-meta', [id, { status: 'archived' }]);
    await recycled;
    await expect(access(created.meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.host.invoke('worktree:restore-for-session', [id], remote)).toMatchObject({ ok: true, snapshotApplied: true });
    expect(await readFile(path.join(created.meta.path, 'file.txt'), 'utf8')).toBe('retained user changes');
    await f.host.invoke('worktree:cancel-precreated', [{ sessionId: 'cancelled-task', path: path.join(repo, '.cindy-worktrees', 'cancelled') }], remote);
    await expect(f.host.invoke('maker:create-session', [{ id: 'cancelled-task', workingDir: repo }])).rejects.toThrow('creation was cancelled');
    expect(await f.host.storage.get('cancelled-task')).toBeNull();
    const lead = await f.host.invoke('maker:create-session', [{ workingDir: repo }], remote) as { id: string };
    const worker = await f.host.invoke('maker:session:enable-orca', [lead.id, { workerAgent: 'claude-code', label: 'Isolated', worktree: { sourceBranch: 'main' } }], remote) as { workerId: string; workerSessionId: string };
    const workerRow = await f.host.storage.get(worker.workerSessionId);
    expect(workerRow?.worktreePath).toBeTruthy();
    expect(workerRow?.workDir).toBe(workerRow?.worktreePath);
    expect(workerRow?.workDir).not.toBe(repo);
    expect(f.native.starts.at(-1)?.workingDir).toBe(workerRow?.workDir);
    await worktrees.manager.awaitBackgroundCheckout(worker.workerSessionId);
    expect(await readFile(path.join(workerRow!.workDir, 'file.txt'), 'utf8')).toBe('original');
    await writeFile(path.join(workerRow!.workDir, 'worker.txt'), 'worker changes');
    const workerRecycled = f.nextPush('worktree:changed');
    await f.host.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: worker.workerId }], remote);
    await workerRecycled;
    await expect(access(workerRow!.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.host.invoke('worktree:restore-for-session', [worker.workerSessionId], remote)).toMatchObject({ ok: true, snapshotApplied: true });
    expect(await readFile(path.join(workerRow!.workDir, 'worker.txt'), 'utf8')).toBe('worker changes');
    const registry = new RemoteResourceRegistry(); registerWorktreeResources(registry, worktrees, f.host);
    const context = { controllerDeviceId: 'terminal-controller', assertCurrent() {} }, client = { protocolVersion: 1, primitives: ['text', 'actions'], locale: 'zh-CN' };
    const formTask = await registry.invoke(context, { client, collectionId: 'worktrees', actionId: 'create', input: { baseRepo: repo, name: 'terminal' } });
    const formId = (formTask.result as { sessionId: string }).sessionId;
    expect((await f.host.storage.get(formId))?.worktreePath).toContain('terminal');
    expect(await registry.list(context, { client, collectionId: 'worktrees' })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ref: { collectionId: 'worktrees', kind: 'worktree', id: formId } })]) });
    await expect(registry.invoke({ ...context, assertCurrent() { throw new Error('CONTROLLER_REVOKED'); } }, { client, collectionId: 'worktrees', actionId: 'create', input: { baseRepo: repo } })).rejects.toThrow('CONTROLLER_REVOKED');
    const scheduler = new TerminalSchedulerHost({ profileDir: owner, tasks: f.host, worktrees, logger, emit() {} }); schedulers.push(scheduler);
    const schedule = await scheduler.invoke('maker:schedule:create', [{ name: 'Worktree schedule', prompt: 'scheduled hello', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: true, agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', workspaceKind: 'project', workingDir: repo, useWorktree: true, persistentSession: true, notify: { desktop: false, feishu: false } }]) as { id: string };
    await scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    const runs = await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{ status: string; sessionId: string }>;
    expect(runs[0]).toMatchObject({ status: 'success' });
    const scheduledTask = await f.host.storage.get(runs[0]!.sessionId);
    expect(scheduledTask?.worktreePath).toBe(scheduledTask?.workDir);
    expect(scheduledTask?.workDir).not.toBe(repo);
    expect(await readFile(path.join(scheduledTask!.workDir, 'file.txt'), 'utf8')).toBe('original');
    await scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    expect(await scheduler.invoke('maker:schedule:list-runs', [schedule.id])).toMatchObject([{ status: 'success', sessionId: scheduledTask!.id }, { status: 'success', sessionId: scheduledTask!.id }]);
  }, 30_000);

  it('discovers remote worker computers through the shared controller without exposing the account directory to guests', async () => {
    const device = (id: string, patch: Record<string, unknown> = {}) => ({ deviceId: id, name: id, platform: 'linux',
      appVersion: null, lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...patch });
    const probed: string[] = [];
    const { host } = await setup(engine(), {
      listOrcaDevices: async () => ({ devices: [device('server'), device('older-client'), device('offline', { online: false }), device('phone', { platform: 'ios' }), device('self', { isSelf: true }), device('disabled', { controlEnabled: false })] }),
      remoteInvoke: async (id, channel) => {
        expect(channel).toBe('maker:orca:remote-worker:caps'); probed.push(id);
        return id === 'server' ? { ok: true, result: { version: 1, workerBridge: true, agentDevice: true } }
          : { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported by older client' } };
      },
    });
    expect(await host.invoke('maker:orca:execution-devices')).toEqual({ devices: [
      { deviceId: 'server', name: 'server', platform: 'linux', supported: true, supportsAgentDevice: true },
      { deviceId: 'older-client', name: 'older-client', platform: 'linux', supported: false },
    ] });
    expect(probed).toEqual(['server', 'older-client']);
    await expect(host.invoke('maker:orca:execution-devices', [], { source: 'remote', sharedTask: { sessionId: 'shared' } as never })).rejects.toThrow();
    expect(probed).toHaveLength(2);
  });
  // Existing GUI/Mobile consumers must observe the durable collaboration
  // projection after a terminal process restart, without internal receipts.
  it('restores team membership through the existing remote GUI read channels', async () => {
    const { host, create } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'worker-link', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.close();
    const restored = create();
    const context = { source: 'remote' as const, deviceId: 'controller', ownerId: 'owner', assertCurrent() {} };
    expect(await restored.invoke('local-db:orca-workflows:get-by-lead', [lead.sessionId], context)).toMatchObject({ id: team.id, status: 'active' });
    expect(await restored.invoke('local-db:orca-workflows:get-by-worker-session', [worker.sessionId], context)).toMatchObject({ id: team.id });
    const batch = await restored.invoke('local-db:orca-workflows:list-workers-by-leads', [[lead.sessionId, 'another-lead', lead.sessionId]], context) as Record<string, Array<Record<string, unknown>>>;
    expect(batch['another-lead']).toEqual([]);
    expect(batch[lead.sessionId]).toMatchObject([{ id: 'worker-link', label: 'build', session: { title: 'Worker' } }]);
    expect(batch[lead.sessionId]![0]).not.toHaveProperty('pendingReport');
    expect(await restored.invoke('local-db:sessions:get', [worker.sessionId], context)).toMatchObject({ orcaRole: 'worker' });
    await expect(restored.invoke('local-db:orca-workflows:list-workers-by-leads', [Array(201).fill(lead.sessionId)], context)).rejects.toThrow('INVALID_ARGUMENT');
    await expect(restored.invoke('local-db:orca-workflows:get-by-lead', [lead.sessionId], { ...context, sharedTask: { sessionId: lead.sessionId } as never })).rejects.toThrow();
  });
  // Integration: the shared dispatcher must commit actual terminal receipts.
  // A paused assignment, a process restart and a released team are the minimum
  // inputs that distinguish persistence from an in-memory queue mock.
  it('persists local collaboration input, restores its sender, and rejects revoked assignments', async () => {
    const { host, create, native } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'durable-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.invoke('maker:input:stop', [worker.sessionId]);
    const dispatch = (target: TerminalTaskHost, content: string) => target.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: worker.sessionId, source: 'lead', senderLabel: 'untrusted label', workerId: 'durable-worker', rawContent: content,
      meta: { source: 'orca', context: 'durable-assignment-test' },
    });
    const queued = await dispatch(host, 'Inspect the project');
    if (!queued.ok) throw new Error('Expected a queued assignment');
    expect(queued.mode).toBe('queued');
    expect(await host.storage.submission(worker.sessionId, queued.clientId)).toMatchObject({ status: 'queued', collaboration: {
      teamId: team.id, source: 'lead', origin: { kind: 'orca', senderSessionId: lead.sessionId, senderLabel: 'Lead' },
    } });
    expect(native.sent).toHaveLength(0);
    await host.close();
    const restored = create();
    expect(await restored.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ pendingQueue: [{
      clientId: queued.clientId, origin: { senderSessionId: lead.sessionId, senderLabel: 'Lead' },
    }] });
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, queued.clientId])).toMatchObject({ status: 'completed' });
    const history = (await restored.storage.history(worker.sessionId)).records.filter(row => row.kind === 'user');
    expect(history).toHaveLength(1);
    expect(history[0].agentMeta).toMatchObject({ origin: { kind: 'orca', senderSessionId: lead.sessionId }, autoReviewUserText: { kind: 'delegated-continuation' } });
    expect(history[0].message).not.toEqual(native.sent[0]);
    expect(JSON.stringify(native.sent[0])).toContain('Inspect the project');
    await restored.invoke('maker:input:stop', [worker.sessionId]);
    const revoked = await dispatch(restored, 'Do not execute after release');
    const edited = await dispatch(restored, 'Replace this delegated input');
    if (!revoked.ok || !edited.ok) throw new Error('Expected queued assignments');
    await restored.invoke('maker:input:update-text', [worker.sessionId, edited.clientId, 'A new human request']);
    expect((await restored.storage.submission(worker.sessionId, edited.clientId))?.collaboration).toBeUndefined();
    await restored.orcaStore.markTeamEnded(team.id, 'completed');
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, revoked.clientId])).toMatchObject({ status: 'failed', error: 'ORCA_ASSIGNMENT_REVOKED' });
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, edited.clientId])).toMatchObject({ status: 'completed' });
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
    expect(JSON.stringify(native.sentFor(worker.sessionId)[1])).toContain('A new human request');
    const users = (await restored.storage.history(worker.sessionId)).records.filter(row => row.kind === 'user');
    expect(users.map(row => row.clientId)).toEqual([queued.clientId, edited.clientId]);
    expect(users[1].agentMeta?.origin).toBeUndefined();
  });

  // Integration: accepted callbacks claim a native turn, not an enqueue. A
  // release during the real change-set preparation must still prevent send.
  it('settles collaboration callbacks at native acceptance and rechecks assignment before sending', async () => {
    const { host, native } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'accepted-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    const events: string[] = [];
    const request = { targetSessionId: worker.sessionId, rawContent: 'Build', source: 'lead' as const,
      senderLabel: 'Lead', workerId: 'accepted-worker', meta: { source: 'orca', context: 'acceptance-test' },
      onAccepted: () => { events.push('accepted'); }, onAcceptedCommit: () => { events.push('commit'); },
      onAcceptedRollback: () => { events.push('rollback'); } };
    await host.invoke('maker:input:stop', [worker.sessionId]);
    const waiting = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
    if (!waiting.ok) throw new Error('Expected queued assignment');
    expect(events).toEqual([]);
    await host.invoke('maker:input:resume', [worker.sessionId]);
    expect(await host.invoke('terminal:tasks:wait', [worker.sessionId, waiting.clientId])).toMatchObject({ status: 'completed' });
    expect(events).toEqual(['accepted', 'commit']);
    const begin = host.changes.begin.bind(host.changes);
    const releaseDuringPreparation = vi.spyOn(host.changes, 'begin').mockImplementationOnce(async (...args) => {
      await begin(...args); await host.orcaStore.markTeamEnded(team.id, 'completed');
    });
    try {
      const rejected = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
      if (!rejected.ok) throw new Error('Expected queued assignment');
      expect(await host.invoke('terminal:tasks:wait', [worker.sessionId, rejected.clientId])).toMatchObject({ status: 'failed' });
      expect(native.sent).toHaveLength(1);
      expect(events).toEqual(['accepted', 'commit']);
    } finally { releaseDuringPreparation.mockRestore(); }
  });

  // Integration: async merge/remove/update share the persisted receipt boundary
  // with controller edits. A stale snapshot and one failed file commit must
  // preserve the newer body and every source message, including after restart.
  it('commits collaboration queue edits atomically and preserves newer controller input', async () => {
    const { host, create } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'queue-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    await host.invoke('maker:input:stop', [worker.sessionId]);
    const ids: string[] = [];
    for (const content of ['first', 'second', 'third']) {
      const result = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ targetSessionId: worker.sessionId,
        source: 'lead', senderLabel: 'Lead', workerId: 'queue-worker', rawContent: content, meta: { source: 'orca', context: 'queue-edit-test' } });
      if (!result.ok) throw new Error('Expected queued assignment');
      ids.push(result.clientId);
    }
    const original = await host.orcaQueue.snapshot(worker.sessionId);
    await host.invoke('maker:input:update-text', [worker.sessionId, ids[0], 'A newer controller edit']);
    expect(await host.orcaQueue.replace(worker.sessionId, ids[0]!, rebuildQueuedOrcaLeadMessage(original[0]!, 'stale overwrite'), original[0])).toBe(false);
    expect(await host.orcaQueue.remove(worker.sessionId, ids[0]!, original[0])).toBe(false);
    expect((await host.storage.submission(worker.sessionId, ids[0]!))?.message?.content).toBe('A newer controller edit');
    await host.invoke('maker:input:set-edit-lock', [worker.sessionId, ids[2], true]);
    expect(await host.orcaQueue.move(worker.sessionId, ids[2]!, 0)).toBe('locked');
    await host.invoke('maker:input:set-edit-lock', [worker.sessionId, ids[2], false]);
    expect(await host.orcaQueue.move(worker.sessionId, ids[2]!, 0)).toBe(0);
    const write = platform.atomicPrivateWrite;
    const failure = vi.spyOn(platform, 'atomicPrivateWrite').mockImplementation(async (file, content, ...rest) => {
      if (file.endsWith(`${worker.sessionId}${path.sep}requests.json`)) throw new Error('fixture queue write failed');
      return write(file, content, ...rest);
    });
    try {
      await expect(host.orcaQueue.merge(worker.sessionId, ids.slice(1), items => rebuildQueuedOrcaLeadMessage(items[0]!, 'Merged task'))).rejects.toThrow('fixture queue write failed');
      expect((await host.storage.queued(worker.sessionId)).map(row => row.requestId)).toEqual([ids[2], ids[0], ids[1]]);
    } finally { failure.mockRestore(); }
    expect(await host.orcaQueue.merge(worker.sessionId, ids.slice(1), items => rebuildQueuedOrcaLeadMessage(items[0]!, 'Merged task'))).toBe(true);
    expect((await host.storage.queued(worker.sessionId)).map(row => row.requestId)).toEqual([ids[2], ids[0]]);
    expect(await host.storage.submission(worker.sessionId, ids[1]!)).toMatchObject({ status: 'interrupted', error: 'INPUT_REMOVED' });
    await host.close();
    const restored = create();
    await restored.ready;
    expect((await restored.orcaQueue.snapshot(worker.sessionId)).map(row => ({ id: row.clientId, text: row.origin?.kind === 'orca' ? row.origin.displayText : row.text })))
      .toEqual([{ id: ids[2], text: 'Merged task' }, { id: ids[0], text: 'A newer controller edit' }]);
  });

  // Integration: native steering ACK belongs to the existing turn. An uncertain
  // ACK must survive restart as paused input and never silently run twice.
  it('steers collaboration into the current native turn and durably pauses uncertain delivery', async () => {
    const { host, create, native, nextPush } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'steer-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    await host.invoke('maker:input:enqueue', [worker.sessionId, { clientId: 'original-turn', text: 'wait-for-steer' }]);
    await native.waitForHeld(worker.sessionId);
    for (;;) {
      const changed = nextPush('terminal:tasks:submission');
      if ((await host.storage.submission(worker.sessionId, 'original-turn'))?.status === 'running') break;
      await changed;
    }
    const accepted = vi.fn();
    const request = { targetSessionId: worker.sessionId, rawContent: 'A correction', source: 'lead' as const,
      senderLabel: 'Lead', workerId: 'steer-worker', delivery: 'steer' as const,
      meta: { source: 'orca', context: 'native-steer-test' }, onAccepted: accepted };
    const sent = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
    expect(sent).toMatchObject({ ok: true, mode: 'steered' });
    expect(native.steered).toHaveLength(1);
    expect(accepted).not.toHaveBeenCalled();
    expect((await host.storage.history(worker.sessionId)).records.filter(row => row.kind === 'user').at(-1)?.agentMeta).toMatchObject({
      delivery: 'steer', origin: { kind: 'orca', senderSessionId: lead.sessionId },
    });
    native.steer.reply = async () => { throw new Error('The provider did not acknowledge within its deadline'); };
    const uncertain = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...request, rawContent: 'An uncertain correction' });
    if (!uncertain.ok) throw new Error('Expected retained input');
    expect(uncertain).toMatchObject({ mode: 'queued', steerFallbackReason: 'STEER_UNCERTAIN' });
    expect(await host.storage.submission(worker.sessionId, uncertain.clientId)).toMatchObject({ status: 'queued', error: 'STEER_DELIVERY_UNCERTAIN' });
    expect(await host.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ queuePaused: true, pendingQueue: [{ clientId: uncertain.clientId }] });
    native.finishHeld(worker.sessionId);
    expect(await host.invoke('terminal:tasks:wait', [worker.sessionId, 'original-turn'])).toMatchObject({ status: 'completed' });
    expect(native.sent).toHaveLength(1);
    await host.close();
    const restored = create();
    expect(await restored.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ queuePaused: true, pendingQueue: [{ clientId: uncertain.clientId }] });
    expect(native.sent).toHaveLength(1);
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, uncertain.clientId])).toMatchObject({ status: 'completed' });
    expect((await restored.storage.submission(worker.sessionId, uncertain.clientId))?.error).toBeUndefined();
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
  });

  // Integration: the actual shared team controller must use terminal queues,
  // resume a dormant worker, report each accepted turn once and release it.
  it('runs shared team controls through durable worker tasks and automatic Lead reports', async () => {
    const { host, native } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const foreign = await host.invoke('maker:create-session', [{ title: 'Other Lead' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.createActiveTeam({ leadSessionId: foreign.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'controlled-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.invoke('maker:close-session', [worker.sessionId]);
    await host.invoke('maker:input:stop', [worker.sessionId]);
    await host.invoke('maker:input:stop', [lead.sessionId]);
    const controls = host.orcaTeamService;
    expect(await controls.sendToWorker({ callerLeadSessionId: foreign.sessionId, targetSessionId: worker.sessionId, message: 'Wrong team' })).toMatchObject({ ok: false });
    const ids: string[] = [];
    for (const message of ['First task', 'Remove this task', 'Last task']) {
      const result = await controls.sendToWorker({ callerLeadSessionId: lead.sessionId, targetSessionId: worker.sessionId, message });
      if (!result.ok || !result.queuedMessageId) throw new Error('Expected queued worker task');
      ids.push(result.queuedMessageId);
    }
    await host.orcaStore.setSessionOrcaRole(worker.sessionId, 'worker');
    expect(await controls.moveWorkerQueuedMessage({ callerLeadSessionId: worker.sessionId, queuedMessageId: ids[0]!, position: 0 })).toMatchObject({ ok: true });
    const updated = await controls.updateWorkerQueuedMessage({ callerLeadSessionId: lead.sessionId, workerRef: 'controlled-worker', queuedMessageId: ids[0]!, message: 'Updated first task' });
    expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
    expect(await controls.cancelWorkerQueuedMessage({ callerLeadSessionId: lead.sessionId, workerRef: 'controlled-worker', queuedMessageId: ids[1]! })).toMatchObject({ ok: true });
    await host.invoke('maker:input:resume', [worker.sessionId]);
    for (const id of [ids[0]!, ids[2]!]) expect(await host.invoke('terminal:tasks:wait', [worker.sessionId, id])).toMatchObject({ status: 'completed' });
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
    const reports = await host.storage.queued(lead.sessionId);
    expect(reports).toHaveLength(2);
    expect(reports.map(row => row.collaboration?.origin)).toEqual([
      expect.objectContaining({ kind: 'orca', senderSessionId: worker.sessionId, senderLabel: 'developer' }),
      expect.objectContaining({ kind: 'orca', senderSessionId: worker.sessionId, senderLabel: 'developer' }),
    ]);
    expect(JSON.stringify(reports[0]!.message)).toContain('Updated first task');
    await host.invoke('maker:input:resume', [lead.sessionId]);
    for (const report of reports) expect(await host.invoke('terminal:tasks:wait', [lead.sessionId, report.requestId])).toMatchObject({ status: 'completed' });
    expect(native.sentFor(lead.sessionId)).toHaveLength(2);
    expect((await host.orcaStore.listWorkersByLead(lead.sessionId))[0]).toMatchObject({ status: 'done' });
    expect(await controls.idleWorker({ callerLeadSessionId: lead.sessionId, workerId: 'controlled-worker', expectedStatus: 'done' })).toMatchObject({ ok: true });
    expect((await host.orcaStore.listWorkersByLead(lead.sessionId))[0]).toMatchObject({ status: 'idle' });
    expect(await controls.archiveWorker({ callerLeadSessionId: lead.sessionId, workerId: 'controlled-worker', onlyIfIdle: true })).toMatchObject({ ok: true });
    expect((await host.storage.get(worker.sessionId))?.archived).toBe(true);
    expect(await host.orcaStore.listWorkersByLead(lead.sessionId)).toEqual([]);
  });

  // Integration: native bootstrap can fail after task persistence; that orphan
  // must not occupy a slot. The replacement's idle release must close its real
  // runtime while preserving native identity for the next assignment.
  it('archives failed Worker bootstrap and releases a completed Worker without losing its native identity', async () => {
    let failWorker = true;
    const native = engine(async (_input, options) => {
      if (failWorker && options.vendorOptions?.orcaRole === 'worker') { failWorker = false; throw new Error('NATIVE_WORKER_START_FAILED'); }
    });
    const { host } = await setup(native);
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:stop', [lead.id]);
    await host.orcaLifecycle.startTeam({ leadSessionId: lead.id });
    const args = { leadSessionId: lead.id, agent: 'claude-code' as const, role: 'developer', label: 'Retry', initialTask: 'Run the assignment' };
    expect(await host.orcaLifecycle.createWorker(args)).toMatchObject({ ok: false });
    const discarded = (await host.storage.list()).filter(task => task.id !== lead.id);
    expect(discarded).toHaveLength(1); expect(discarded[0]?.archived).toBe(true);
    const worker = await host.orcaLifecycle.createWorker(args);
    if (!worker.ok) throw new Error(worker.message);
    await vi.waitFor(async () => expect((await host.orcaStore.workerForLead(lead.id, worker.workerId))?.status).toBe('done'));
    // The Lead receipt commits before the Worker finishes its own turn journal.
    // An idle scan must protect that live tail, so age it only after settlement.
    await vi.waitFor(() => expect(host.isTurnRunning(worker.workerSessionId)).toBe(false));
    const sdkId = (await host.storage.get(worker.workerSessionId))!.sdkSessionId;
    await host.invoke('maker:collaboration-settings:set', [{ key: 'workerIdleReleaseMinutes', value: 1 }]);
    await host.orcaStore.touchWorker(worker.workerId, Date.now() - 120_000);
    await host.orcaIdle.scanNow();
    expect(await host.orcaTools.api.getWorkerStatus({ leadSessionId: lead.id, workerId: worker.workerId })).toMatchObject({ status: 'idle', session_status: 'not_running' });
    const next = await host.orcaTeamService.sendToWorker({ callerLeadSessionId: lead.id, targetSessionId: worker.workerSessionId, message: 'Another assignment' });
    if (!next.ok || !next.queuedMessageId) throw new Error('Expected worker assignment');
    expect(await host.invoke('terminal:tasks:wait', [worker.workerSessionId, next.queuedMessageId])).toMatchObject({ status: 'completed' });
    expect((await host.storage.get(worker.workerSessionId))!.sdkSessionId).toBe(sdkId);
    expect(native.sentFor(worker.workerSessionId)).toHaveLength(2);
  });

  // Integration: GUI IPC + real Maker/storage must recover a completed Worker
  // across either crash window. Existing in-process report tests cannot expose
  // missing outbox durability or an ACK lost after the Lead receipt is written.
  it.each(['before-outbox', 'after-lead-commit'] as const)('recovers one GUI-created Worker report after %s', async fault => {
    const { host, create, native } = await setup(engine(), { deferPendingTasks: true });
    let authorized = true;
    const remote = { source: 'remote' as const, deviceId: 'gui-controller', ownerId: 'test-owner',
      assertCurrent: () => { if (!authorized) throw new Error('CONTROLLER_REVOKED'); } };
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:stop', [lead.id]);
    // The real remote test exposed INVALID_PARAMS being obscured as INTERNAL.
    // A rejected locator must carry its safe wire code and create no team.
    await expect(host.invoke('maker:session:enable-orca', [lead.id, { label: '原生回报验收' }], remote))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'Orca operation failed' });
    expect(await host.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
    expect(await host.invoke('maker:collaboration-settings:set', [{ key: 'workerIdleReleaseMinutes', value: 1 }], remote)).toMatchObject({ workerIdleReleaseMinutes: 1 });
    const created = await host.invoke('maker:session:enable-orca', [lead.id, { workerAgent: 'claude-code', label: 'Recovery', delegateTask: 'Durable GUI assignment' }], remote) as { workerId: string; workerSessionId: string };
    const pending = await host.storage.queued(created.workerSessionId);
    expect(pending).toHaveLength(1);
    expect(await host.invoke('maker:worker:list', [lead.id], remote)).toEqual([expect.objectContaining({ id: created.workerId })]);
    if (fault === 'before-outbox') vi.spyOn(host.orcaReports, 'terminal').mockRejectedValueOnce(new Error('simulated process exit before report preparation'));
    else {
      const dispatch = host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage;
      vi.spyOn(host.orcaDispatcher, 'dispatchOrEnqueueOrcaInterAgentMessage').mockImplementation(async input => {
        const result = await dispatch(input);
        if (input.source === 'worker') throw new Error('simulated lost acknowledgement after Lead commit');
        return result;
      });
    }
    host.resumePending();
    expect(await host.invoke('terminal:tasks:wait', [created.workerSessionId, pending[0]!.requestId])).toMatchObject({ status: 'completed' });
    expect(await host.storage.queued(lead.id)).toHaveLength(fault === 'before-outbox' ? 0 : 1);
    expect(native.sentFor(created.workerSessionId)).toHaveLength(1);
    await host.close();
    const restarted = create(); await restarted.ready; await restarted.orcaReports.recover();
    const reports = await restarted.storage.queued(lead.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.collaboration?.origin.displayText).toContain('Durable GUI assignment');
    expect((await restarted.storage.submission(created.workerSessionId, pending[0]!.requestId))?.orcaReport).toMatchObject({ phase: 'delivered', clientId: reports[0]!.requestId });
    await restarted.orcaReports.recover();
    expect(await restarted.storage.queued(lead.id)).toHaveLength(1);
    expect(native.sentFor(created.workerSessionId)).toHaveLength(1);
    expect(await restarted.invoke('maker:collaboration-settings:get', [], remote)).toMatchObject({ workerIdleReleaseMinutes: 1 });
    authorized = false;
    await expect(restarted.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: created.workerId }], remote)).rejects.toThrow('CONTROLLER_REVOKED');
    expect((await restarted.storage.get(created.workerSessionId))?.archived).not.toBe(true);
    authorized = true;
    await restarted.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: created.workerId }], remote);
    expect((await restarted.storage.get(created.workerSessionId))?.archived).toBe(true);
    await restarted.invoke('maker:session:disable-orca', [lead.id], remote);
    expect(await restarted.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
  });

  // Integration: public MCP creation must boot real Maker Sessions with their
  // role, persist local assignments, and settle explicit reports exactly once.
  it.each([false, true])('creates teams through native MCP and restores identity (report settlement crash: %s)', async settlementCrash => {
    const connect = async (input: RuntimeInput, options: StartSessionOptions, name: string) => {
      const tools = input.tools!, ctx = { sessionId: options.sessionId!, sessionInstanceId: options.sessionInstanceId!,
        workingDir: options.workingDir, agentKind: input.selection.agentKind, vendorOptions: options.vendorOptions,
        mcpCallerKind: 'root' as const, mcpCallerAttested: true };
      const bridge = tools.pi(ctx), client = new McpClient({ name: 'terminal-orca-integration', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpBridge!.servers.find(server => server.name === name)!.url),
        { requestInit: { headers: { Authorization: `Bearer ${bridge.mcpBridge!.token}` } } }));
      return { call: async (tool: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError) return { ok: false };
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      }, close: async () => { await client.close(); bridge.disposeSessionCtx?.(); } };
    };
    const reports: unknown[] = [];
    const native = engine(undefined, async (input, options) => {
      if (options.vendorOptions?.orcaRole !== 'worker') return;
      const bridge = await connect(input, options, 'orca_worker_bridge');
      try {
        reports.push(await bridge.call('send_to_lead', { worker_id: options.vendorOptions.orcaWorkerId, message: 'MCP_WORKER_RESULT' }));
      } finally { await bridge.close(); }
    });
    const { host, create } = await setup(native, { deferPendingTasks: true });
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:stop', [lead.id]);
    const control = await connect(native.inputs[0]!, native.starts[0]!, 'cindy_orca');
    let workerId = '', workerSessionId = '';
    try {
      expect(await control.call('start_team', {})).toMatchObject({ ok: true });
      const invalid = await control.call('create_worker', { role: 'developer', label: 'invalid', agent: 'claude-code', model: 'unavailable-model' });
      expect(invalid.ok).toBe(false);
      const created = await control.call('create_worker', { role: 'developer', label: 'builder', agent: 'claude-code', initial_task: 'Complete the assigned work' });
      expect(created).toMatchObject({ ok: true });
      workerId = created.worker_id; workerSessionId = created.worker_session_id;
      expect(workerId).toBeTruthy(); expect(workerSessionId).toBeTruthy();
      const worker = native.starts.find(start => start.sessionId === workerSessionId)!;
      expect(worker.vendorOptions).toMatchObject({ orcaRole: 'worker', orcaWorkerId: workerId, orcaLeadSessionId: lead.id });
      expect(await host.storage.get(workerSessionId)).toMatchObject({ orcaRole: 'worker', providerId: 'fixture', permissionMode: 'bypassPermissions' });
      expect((await host.storage.get(workerSessionId))?.source).not.toBe('plugin');
      const queued = await host.storage.queued(workerSessionId);
      expect(queued).toHaveLength(1);
      if (settlementCrash) {
        // Crash after the Lead received an explicit report, before Worker status
        // commits. Automatic completion must not repair the simulated crash.
        vi.spyOn(host.orcaTeamService, 'settleReportedWorker').mockRejectedValueOnce(new Error('simulated exit before Worker settlement'));
        vi.spyOn(host.orcaReports, 'terminal').mockRejectedValueOnce(new Error('simulated process exit'));
      }
      host.resumePending();
      expect(await host.invoke('terminal:tasks:wait', [workerSessionId, queued[0]!.requestId])).toMatchObject({ status: 'completed' });
      expect(reports).toEqual([expect.objectContaining(settlementCrash ? { ok: false } : { ok: true, queued: true })]);
      expect((await host.storage.submission(workerSessionId, queued[0]!.requestId))?.orcaReport)
        .toMatchObject({ phase: 'delivered', ...(settlementCrash ? {} : { settled: true }) });
      if (settlementCrash) expect((await host.orcaStore.listWorkersByLead(lead.id))[0]?.status).toBe('running');
      const leadQueue = await host.orcaQueue.snapshot(lead.id);
      expect(leadQueue).toHaveLength(1);
      expect(leadQueue[0]!.origin).toMatchObject({ kind: 'orca', displayText: 'MCP_WORKER_RESULT', senderSessionId: workerSessionId });
    } finally { await control.close(); }
    await host.close();
    const restarted = create(); await restarted.ready; await restarted.orcaReports.recover();
    expect(await restarted.orcaQueue.snapshot(lead.id)).toHaveLength(1);
    expect(await restarted.orcaStore.listWorkersByLead(lead.id)).toEqual([expect.objectContaining({ id: workerId, status: 'done' })]);
    await restarted.invoke('maker:set-thinking-enabled', [lead.id, true]);
    const currentInput = native.inputs.at(-1)!, currentStart = native.starts.at(-1)!;
    expect(currentStart.vendorOptions).toMatchObject({ orcaRole: 'lead', orcaLeadSessionId: lead.id });
    const resumedControl = await connect(currentInput, currentStart, 'cindy_orca');
    try {
      expect(await resumedControl.call('get_workspace_info', {})).toMatchObject({ ok: true, worker_count: 1 });
      expect(await resumedControl.call('end_team', {})).toMatchObject({ ok: true });
      expect((await restarted.storage.get(workerSessionId))?.archived).toBe(true);
      expect((await restarted.storage.get(lead.id))?.orcaRole).toBeNull();
      expect(await restarted.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
    } finally { await resumedControl.close(); }
  });

  // Integration: real MCP transports must preserve harness-attested lineage.
  // An inherited task token alone cannot make a child Agent a root reporter;
  // a later human turn must also lose the preceding Lead assignment identity.
  it('routes worker MCP reports through attested harness contexts and the accepted input', async () => {
    const results: Array<{ transport: string; caller: string; result: unknown }> = [];
    const forwarded: Array<{ device: string; request: Record<string, unknown> }> = [];
    const native = engine(undefined, async (input, options) => {
      const tools = input.tools!, provider = tools.providers.find(provider => provider.name === 'orca_worker_bridge')!;
      for (const transport of ['sdk', 'codex', 'pi'] as const) for (const caller of ['root', 'descendant', 'unknown'] as const) {
        const ctx = { sessionId: options.sessionId!, sessionInstanceId: options.sessionInstanceId!, workingDir: options.workingDir,
          agentKind: transport === 'sdk' ? 'claude-code' as const : transport, mcpCallerKind: caller, mcpCallerAttested: caller !== 'unknown', vendorOptions: {} };
        const client = new McpClient({ name: 'worker-report-test', version: '1' });
        let dispose = () => {};
        try {
          if (transport === 'sdk') {
            const server = (provider.toClaudeSdkConfig!(ctx) as { instance: McpServer }).instance;
            const pair = InMemoryTransport.createLinkedPair(); await server.connect(pair[1]); await client.connect(pair[0]);
          } else if (transport === 'pi') {
            const bridge = tools.pi(ctx); dispose = bridge.disposeSessionCtx!;
            await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpBridge!.servers.find(server => server.name === provider.name)!.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.mcpBridge!.token}` } } }));
          } else {
            tools.registerCodexMcpThreadContext({ ...ctx, threadId: `thread-${caller}` });
            dispose = () => tools.unregisterCodexMcpThreadContext(`thread-${caller}`, ctx.sessionInstanceId);
            const config = provider.toCodexMcpConfig!(ctx)!;
            await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${tools.env[config.bearerTokenEnvVar!]}` } } }));
          }
          results.push({ transport, caller, result: await client.callTool({ name: 'send_to_lead', arguments: { worker_id: 'worker-1', message: 'Finished' }, ...(transport === 'codex' ? { _meta: { threadId: `thread-${caller}` } } : {}) }) });
        } finally { await client.close(); dispose(); }
      }
    });
    const { host, root } = await setup(native, { remoteInvoke: async (device, _channel, args) => {
      forwarded.push({ device, request: args[0] as Record<string, unknown> });
      return { ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } };
    } });
    const context = { source: 'remote' as const, deviceId: 'lead-pc', ownerId: 'owner', assertCurrent() {} };
    await expect(host.invoke('maker:orca:remote-worker:caps', [], context)).resolves.toMatchObject({ workerBridge: true });
    await host.invoke('maker:orca:remote-worker:open', [{ sessionId: 'report-worker', agentKind: 'claude-code', permissionMode: 'auto', title: 'Worker', workingDir: root,
      lead: { leadSessionId: 'lead-task', leadTitle: 'Lead', workerLabel: 'Research' } }], context);
    await host.invoke('maker:input:enqueue', ['report-worker', { clientId: 'lead-assignment', text: 'Research', origin: { kind: 'orca', displayText: 'Research' } }], context);
    expect(await host.invoke('terminal:tasks:wait', ['report-worker', 'lead-assignment'])).toMatchObject({ status: 'completed' });
    expect(results).toHaveLength(9);
    expect(results.filter(row => row.caller === 'root').every(row => !(row.result as { isError: boolean }).isError)).toBe(true);
    expect(results.filter(row => row.caller === 'descendant').every(row => JSON.stringify(row.result).includes('NESTED_AGENT_NOT_ALLOWED'))).toBe(true);
    expect(results.filter(row => row.caller === 'unknown').every(row => JSON.stringify(row.result).includes('CALLER_PROVENANCE_REQUIRED'))).toBe(true);
    expect(forwarded).toHaveLength(3);
    for (const call of forwarded) expect(call).toMatchObject({ device: 'lead-pc', request: { sessionId: 'report-worker', leadSessionId: 'lead-task', reportedInputClientIds: ['lead-assignment'] } });
    await host.invoke('maker:send', ['report-worker', { clientId: 'human-turn', text: 'Now answer my question.' }]);
    expect(await host.invoke('terminal:tasks:wait', ['report-worker', 'human-turn'])).toMatchObject({ status: 'completed' });
    expect(results).toHaveLength(18);
    expect(results.slice(9).filter(row => row.caller === 'root').every(row => JSON.stringify(row.result).includes('NOT_LEAD_ASSIGNED_TURN'))).toBe(true);
    expect(forwarded).toHaveLength(3);
  });

  // Integration: the execution host must persist the authenticated Lead together
  // with the selected route before starting Maker. A duplicate open, restart,
  // local queue edit and release exercise identities absent from ordinary tasks.
  it('receives remote workers with durable ownership and revocable Lead assignments', async () => {
    let persistedBeforeStart: Record<string, unknown> | undefined;
    const native = engine(async (input, options) => {
      persistedBeforeStart = JSON.parse(await readFile(path.join(input.profileDir, 'tasks', options.sessionId!, 'task.json'), 'utf8'));
    });
    const { host, root, create } = await setup(native, { deviceId: 'execution-pc' });
    const context = { source: 'remote' as const, deviceId: 'lead-pc', ownerId: 'owner', assertCurrent() {}, sourceDevice: { deviceId: 'lead-pc', name: 'Lead computer', platform: 'desktop' as const } };
    const request = { sessionId: 'remote-worker', agentKind: 'claude-code', permissionMode: 'auto', title: 'Remote worker', workingDir: root,
      lead: { leadSessionId: 'lead-task', leadTitle: 'Lead task', workerLabel: 'Research', leadDeviceId: 'spoofed' } };
    const open = (target: TerminalTaskHost, input = request) => target.invoke('maker:orca:remote-worker:open', [input], context);
    await expect(host.invoke('maker:orca:remote-worker:caps')).rejects.toThrow(/PRECONDITION_FAILED/);
    await expect(host.invoke('maker:orca:remote-worker:open', [request], { ...context, sharedTask: { sharedTaskId: 'share', sessionId: 'remote-worker', memberId: 'guest', accountId: 'guest' } })).rejects.toThrow(/SHARED_TASK_PERMISSION_DENIED/);
    const [first, duplicate] = await Promise.all([open(host), open(host)]);
    expect(duplicate).toEqual(first);
    expect(native.starts).toHaveLength(1);
    expect(persistedBeforeStart).toMatchObject({ providerId: 'fixture', model: 'test-model', orcaRemoteLead: { leadDeviceId: 'lead-pc', leadSessionId: 'lead-task' } });
    await expect(host.invoke('maker:orca:remote-worker:open', [request], { ...context, deviceId: 'another-pc' })).rejects.toThrow(/ALREADY_EXISTS/);
    await expect(host.invoke('maker:orca:remote-worker:models', [{ agent: 'claude-code', agentDeviceId: 'execution-pc' }], context)).resolves.toMatchObject({ agentDeviceId: null, claude_code: [{ id: 'test-model', providers: [{ id: 'fixture' }] }] });

    const item = (clientId: string) => ({ clientId, text: 'Lead assignment', origin: { kind: 'orca', senderLabel: 'Spoofed label', displayText: 'Research this.' } });
    await host.invoke('maker:input:enqueue', ['remote-worker', item('assigned')], context);
    await host.invoke('terminal:tasks:wait', ['remote-worker', 'assigned']);
    const history = (await host.storage.history('remote-worker')).records;
    expect(history.find(row => row.clientId === 'assigned')?.agentMeta).toMatchObject({ origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'Research this.' }, autoReviewUserText: { kind: 'delegated-continuation' } });

    await host.invoke('maker:input:stop', ['remote-worker']);
    await host.invoke('maker:input:enqueue', ['remote-worker', item('edited')], context);
    await host.invoke('maker:input:update-text', ['remote-worker', 'edited', 'My own request']);
    expect((await host.storage.submission('remote-worker', 'edited'))?.orca).toBeUndefined();
    await host.close();
    const resumed = create();
    expect(await open(resumed)).toEqual(first);
    expect((await resumed.storage.get('remote-worker'))?.orcaRemoteLead?.leadDeviceId).toBe('lead-pc');
    await resumed.invoke('maker:input:resume', ['remote-worker']);
    await resumed.invoke('terminal:tasks:wait', ['remote-worker', 'edited']);
    expect((await resumed.storage.history('remote-worker')).records.find(row => row.clientId === 'edited')?.agentMeta?.origin).toBeUndefined();

    await resumed.invoke('maker:input:stop', ['remote-worker']);
    await resumed.invoke('maker:input:enqueue', ['remote-worker', item('released')], context);
    await resumed.invoke('maker:orca:remote-worker:release', [{ sessionId: 'remote-worker' }], context);
    await resumed.invoke('maker:input:resume', ['remote-worker']);
    await resumed.invoke('terminal:tasks:wait', ['remote-worker', 'released']);
    expect(await resumed.storage.submission('remote-worker', 'released')).toMatchObject({ status: 'failed', error: 'REMOTE_WORKER_RELEASED' });
    expect((await resumed.storage.history('remote-worker')).records.some(row => row.clientId === 'released')).toBe(false);
    expect(await resumed.storage.get('remote-worker')).not.toBeNull();
    await expect(open(resumed)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  // Integration: without the host delegate Auto fell back to an unavailable
  // reviewer. Exercise real candidate HTTP and the core authority fence; a
  // closed task must revoke its pending result and abort the network request.
  it('runs Auto review through the connected auxiliary model and revokes a closed task',async()=>{
    const {host,root,native}=await setup();
    let reply=async()=>'{"verdict":"allow"}';
    const api=await auxiliaryFixture(host,()=>reply());
    let release=()=>{};
    try{
      const task=await host.invoke('maker:create-session',[{workingDir:root,permissionMode:'auto'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'Read project files.',clientId:'auto-input'}]);
      await host.invoke('terminal:tasks:wait',[task.id,'auto-input']);
      const delegate=native.inputs.find(input=>input.taskId===task.id)!.reviewAutoPermissionAction!;
      const request:AutoReviewRequest={sessionId:task.id,agentKind:'claude-code',providerId:'fixture',model:'test-model',userIntent:'Read project files.',action:{kind:'exec',command:'ls'},workspaceRoots:[root],platform:process.platform};
      const run=()=>withAutoReviewContext(request,delegate,async prepared=>await delegate(prepared)??{verdict:'ask'});
      expect(await run()).toEqual({verdict:'allow'});
      expect(api.requests).toHaveLength(1);
      let entered!:()=>void;
      const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      reply=async()=>{entered();await gate;return '{"verdict":"allow"}';};
      const pending=run();await started;
      await host.invoke('maker:close-session',[task.id]);
      expect(await pending).toMatchObject({verdict:'ask',unavailable:true});
      expect(api.requests).toHaveLength(2);
    }finally{release();await api.close();}
  });

  // Integration: companion settings previously never reached the native
  // permission mode/reviewer. Exercise resource + GUI updates, durable rollback,
  // actual auxiliary HTTP, and scheduled-input authority through real Maker.
  it('persists companion permissions and reviews only owner intent through the connected auxiliary model', async () => {
    const { host, root, native } = await setup();
    let reply = async () => '{"verdict":"allow"}';
    const api = await auxiliaryFixture(host, () => reply());
    const companion = new TerminalCompanionHost({ root: path.join(root, 'companions'), profileDir: root,
      models: host.models, logger, guard() {}, emit() {}, binary: async () => process.execPath,
      createAgent: native.create, utility: host.utility, permissionModes: kind => host.channelRuntime().getCapabilities(kind).permissionModes });
    let release = () => {};
    try {
      await companion.modelSettings.saveDefaults([{ agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', fastMode: false }]);
      const profile = await companion.create({ name: 'Permission fixture' });
      const registry = new RemoteResourceRegistry(); registerCompanionResources(registry, companion);
      const client = { protocolVersion: 1 as const, primitives: ['form'], locale: 'zh-CN' }, context = { controllerDeviceId: 'owner' };
      const ref = { collectionId: 'teammates', kind: 'bot', id: profile.id };
      const before = await registry.get(context, { client, ref });
      expect(before.actions?.find(action => action.id === 'full-access')?.confirmation).toBeDefined();
      await registry.invoke(context, { client, collectionId: 'teammates', resourceRef: ref, actionId: 'permission', input: { mode: 'auto' } });
      expect(native.starts).toHaveLength(0);
      const send = async (text: string, clientId: string, origin?: Parameters<TerminalCompanionHost['send']>[3]) => {
        const result = await companion.send(profile.id, text, clientId, origin); await result.completion;
      };
      await send('Read files only. Do not delete anything.', 'owner');
      expect(native.starts.at(-1)?.permissionMode).toBe('auto');
      const delegate = native.inputs.find(input => input.taskId === profile.sessionId)!.reviewAutoPermissionAction!;
      const request: AutoReviewRequest = { sessionId: profile.sessionId, agentKind: 'claude-code', providerId: 'fixture', model: 'test-model',
        userIntent: 'Read files only.', action: { kind: 'exec', command: 'ls' }, workspaceRoots: [companion.profiles.home(profile.id)], platform: process.platform };
      const run = () => withAutoReviewContext(request, delegate, async prepared => await delegate(prepared) ?? { verdict: 'ask' });
      expect(await run()).toEqual({ verdict: 'allow' }); expect(api.requests).toHaveLength(1);
      await send('Delete all files.', 'scheduled', { source: 'local', scheduler: { kind: 'scheduler', scheduleId: 'fixture', scheduleName: 'Fixture', runId: 'run' } });
      const intent = JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
      expect(intent).toContain('Do not delete anything.'); expect(intent).not.toContain('Delete all files.');
      const update = vi.spyOn(companion.storage, 'update').mockRejectedValueOnce(new Error('fixture disk unavailable'));
      await expect(companion.invoke('maker:set-permission-mode', [profile.sessionId, 'ask'], { source: 'local' })).rejects.toThrow('fixture disk unavailable');
      update.mockRestore();
      expect(native.permissionModes.slice(-2)).toEqual(['ask', 'auto']);
      expect((await companion.permissionState(profile.id)).mode).toBe('auto');
      await expect(registry.invoke(context, { client, collectionId: 'teammates', resourceRef: ref, actionId: 'permission', input: { mode: 'bypassPermissions' } })).rejects.toThrow('PERMISSION_CONFIRMATION_REQUIRED');
      await registry.invoke(context, { client, collectionId: 'teammates', resourceRef: ref, actionId: 'full-access' });
      expect((await registry.get(context, { client, ref })).revision).not.toBe(before.revision);
      expect(await companion.invoke('local-db:sessions:get', [profile.sessionId], { source: 'local' })).toMatchObject({ permissionMode: 'bypassPermissions' });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      reply = async () => { entered(); await gate; return '{"verdict":"allow"}'; };
      const pending = run(); await started; await companion.stop(profile.id);
      expect(await pending).toMatchObject({ verdict: 'ask', unavailable: true });
      await send('Continue reading.', 'resumed');
      expect(native.starts.at(-1)?.permissionMode).toBe('bypassPermissions');
      expect(JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT])).not.toContain('Delete all files.');
    } finally { release(); await companion.close(); await api.close(); }
  });

  it('keeps guest and scheduled input separate from owner authorization across task resume',async()=>{
    const {host,root,native}=await setup();
    const task=await host.invoke('maker:create-session',[{workingDir:root,permissionMode:'auto'}]) as {id:string};
    const send=async(text:string,id:string,context?:Parameters<TerminalTaskHost['invoke']>[2])=>{
      await host.invoke('maker:send',[task.id,{text,clientId:id}],context);
      await host.invoke('terminal:tasks:wait',[task.id,id]);
    };
    await send('Inspect the repository. Do not delete files.','owner-input');
    await send('Guest requests deletion.','guest-input',{source:'remote',deviceId:'peer',assertCurrent(){},sharedTask:{sharedTaskId:'share',sessionId:task.id,memberId:'member',accountId:'guest'}});
    expect(native.sends.at(-1)?.turnPermissionPolicy?.autoReviewContext).toEqual({requesterAuthority:'guest',source:'group'});
    await host.invoke('maker:close-session',[task.id]);
    await send('Continue the inspection.','owner-resume');
    const restored=JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
    expect(restored).toContain('Do not delete files.');expect(restored).not.toContain('Guest requests deletion.');
    await send('Delete everything automatically.','scheduled-input',{source:'local',scheduler:{kind:'scheduler',scheduleId:'fixture',scheduleName:'Fixture',runId:'run'}});
    const scheduled=JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
    expect(scheduled).toContain('Do not delete files.');expect(scheduled).not.toContain('Delete everything automatically.');
  });
  // Integration: real Feishu device flow, resource lease and encrypted v3
  // controller. Only external HTTP is replaced. A raw authorization code in
  // resource traffic, a wrong controller, or a late cancelled poll is a bug.
  it('keeps Feishu registration on the initiating encrypted controller through expiry and cancellation', async () => {
    const { host: tasks, root, vault } = await setup();
    let active = true, wrongPeer = false;
    const guard = () => { if (!active) throw new Error('OWNER_CHANGED'); };
    const events: unknown[] = [], wire: unknown[] = [];
    const connections = new TerminalImConnections({ tasks, root, logger, assertCurrent: guard, emit: (channel, payload) => events.push({ channel, payload }), secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } });
    const configuration = new TerminalConfiguration(tasks.capabilities, undefined, { revision: () => connections.version(), registration: connections.registration, save: (id, value) => connections.saveConfiguration(id, value) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, tasks, configuration);
    const secrets = { get: async (key: string) => vault.get(key) ?? null, set: async (key: string, value: string) => { vault.set(key, value); }, delete: async (key: string) => { vault.delete(key); } };
    const make = (deviceId: string): TerminalProtectedInput => new TerminalProtectedInput({ root: path.join(root, deviceId), secrets,
      scope: () => ({ realm: 'global', membershipId: 'owner', deviceId }), assertCurrent: guard, remoteEnabled: () => true, taskExists: async () => true, emit: (channel, payload) => events.push({ channel, payload }),
      invoke: async (_device, channel, args) => {
        wire.push({ channel, args });
        const result = channel === 'maker:remote-resources:invoke'
          ? await registry.invoke({ controllerDeviceId: deviceId, assertCurrent: guard }, args[0] as Parameters<typeof registry.invoke>[1])
          : await host.request(wrongPeer ? 'another-controller' : deviceId, args[0]);
        wire.push({ result }); return { ok: true, result };
      },
    });
    const host = make('host'), controller = make('controller'); host.configureSettings(configuration);
    const http = vi.spyOn(connections.transport.host, 'httpPostForm').mockImplementation(async (_url, form) => ({ status: 200, body: form.get('action') === 'begin'
      ? { device_code: 'private-device-token', user_code: 'ABCD-EFGH', expires_in: 300, interval: 1 }
      : { error: 'expired_token', error_description: 'private-device-token' } }));
    try {
      await Promise.all([connections.groups.ready, connections.telegramSettings.ready]);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      wrongPeer = true;
      await expect(controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' })).rejects.toThrow();
      expect(http).not.toHaveBeenCalled(); wrongPeer = false;
      const begun = await controller.channelRegistration({ command: 'begin', service: 'lark', deviceId: 'host' });
      expect(begun.state).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: expect.stringContaining('https://open.larksuite.com/') });
      expect(JSON.stringify(begun)).not.toContain('private-device-token');
      await connections.invoke('feishuBot:set-lifecycle-announcement', { enabled: false });
      expect(await controller.channelRegistration({ command: 'read', id: begun.id })).toMatchObject({ state: { status: 'pending' } });
      await expect(host.channelRegistration({ command: 'read', id: begun.id })).rejects.toThrow('REGISTRATION_STALE');
      await vi.advanceTimersByTimeAsync(1100);
      expect(await controller.channelRegistration({ command: 'read', id: begun.id })).toEqual({ id: begun.id, state: { status: 'expired' } });
      const next = await controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' });
      await controller.channelRegistration({ command: 'cancel', id: next.id });
      const calls = http.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1100);
      expect(http).toHaveBeenCalledTimes(calls);
      await expect(controller.channelRegistration({ command: 'read', id: next.id })).rejects.toThrow('REGISTRATION_STALE');
      const pending = await controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' });
      active = false;
      await expect(controller.channelRegistration({ command: 'read', id: pending.id })).rejects.toThrow('OWNER_CHANGED');
      for (const secret of ['private-device-token', 'ABCD-EFGH']) expect(JSON.stringify({ wire, events })).not.toContain(secret);
    } finally {
      active = true; await controller.close(); await host.close(); await connections.close(); configuration.close(); http.mockRestore(); vi.useRealTimers();
    }
  });
  // The terminal SQLite schema must preserve the shared cursor receipt and
  // bot namespace rules, including a daemon restart between inbound turns.
  it('persists group history and compensated cursors without mixing bot identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-group-test-')); roots.push(root);
    await mkdir(path.join(root, 'im'));
    const original = new Database(path.join(root, 'im', 'history.sqlite'));
    original.exec(GROUP_WINDOW_SCHEMA_SQL); original.pragma('user_version = 1'); original.close();
    let store = new TerminalGroupWindows(root, () => {}, logger);
    try {
      let window = store.channel('wecom-personal');
      const entry = { botId: 'bot-a', chatId: 'group', threadId: '', messageId: 'earlier', author: { name: 'Alice' }, text: 'retained group context', sentAt: Date.now() };
      await window.record(entry);
      await window.record({ ...entry, botId: 'bot-b', text: 'isolated bot context' });
      await window.record({ ...entry, messageId: 'trigger', text: 'current trigger' });
      const query = { botId: 'bot-a', chatId: 'group', threadId: '', triggerMessageId: 'trigger' };
      const first = await window.buildContextPrefix(query);
      expect(first.prefix).toContain('retained group context');
      expect(first.prefix).not.toContain('isolated bot context');
      expect(first.prefix).not.toContain('current trigger');
      const receipt = await first.commit();
      expect((await window.buildContextPrefix(query)).prefix).toBe('');
      expect(receipt).toBeDefined(); await receipt!.rollback();
      const replay = await window.buildContextPrefix(query);
      expect(replay.prefix).toContain('retained group context');
      await replay.commit();
      await store.close();
      store = new TerminalGroupWindows(root, () => {}, logger);
      window = store.channel('wecom-personal');
      expect((await window.buildContextPrefix(query)).prefix).toBe('');
      expect((await window.buildContextPrefix({ ...query, botId: 'bot-b' })).prefix).toContain('isolated bot context');
      expect(await window.listKnownGroups('bot-a')).toEqual([{ chatId: 'group', chatName: null }]);
      expect(await store.search({ lane: { provider: 'wecom-personal:bot-b', chatId: 'group', threadId: '' }, query: 'isolated' })).toMatchObject([{ messageId: 'earlier' }]);
      expect(await store.search({ lane: { provider: 'wecom-personal:bot-a', chatId: 'group', threadId: '' }, query: 'isolated' })).toEqual([]);
      await window.record({ ...entry, messageId: 'not-admitted', text: 'must remain unread after shutdown' });
      const unaccepted = await window.buildContextPrefix({ ...query, triggerMessageId: '' });
      let continueGuard!: (valid: boolean) => void, reached!: () => void;
      const checkpoint = new Promise<void>(resolve => { reached = resolve; });
      let guardCalls = 0;
      const committing = unaccepted.commit(async () => {
        if (++guardCalls === 1) return true;
        reached(); return new Promise<boolean>(resolve => { continueGuard = resolve; });
      });
      await checkpoint;
      const closing = store.close();
      continueGuard(false);
      await committing; await closing;
      store = new TerminalGroupWindows(root, () => {}, logger);
      expect((await store.channel('wecom-personal').buildContextPrefix({ ...query, triggerMessageId: '' })).prefix).toContain('must remain unread after shutdown');
    } finally { await store.close(); }
  });
  // Real Discord transport, encrypted vault, media ledger and task composition;
  // only Discord's remote gateway and vendor process are replaced at their I/O.
  it('connects the official Discord transport to encrypted settings and terminal tasks', async () => {
    const { host, native, root } = await setup();
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'discord');
    const secrets = new TerminalSecretStore(path.join(root, 'vault'));
    await secrets.open(); await secrets.initialize('machine');
    type GatewayFactory = NonNullable<import('@cindy/im').DiscordIMOptions['gatewayFactory']>;
    let inbound!: Parameters<GatewayFactory>[0];
    const output: unknown[] = [];
    const connected: string[] = [];
    const channel = { id: 'dm-owner', send: async (payload: unknown) => { output.push(payload); return { id: String(output.length) }; },
      messages: { fetch: async () => ({ edit: async (payload: unknown) => { output.push(payload); }, delete: async () => {} }) } };
    const client = { users: { fetch: async () => ({ createDM: async () => channel }) }, channels: { fetch: async () => channel } };
    let current = true;
    const guard = () => { if (!current) throw new Error('OWNER_CHANGED'); };
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent: guard, emit() {}, secrets: {
      getSync: key => secrets.getSync(key), setSync: (key, value) => secrets.setSync(key, value), deleteSync: key => secrets.deleteSync(key), available: () => !secrets.status().locked,
    } }, { discord: { gatewayFactory: handlers => {
      inbound = handlers;
      return { appId: 'test-app', botTag: 'test#0001', client: client as unknown as ReturnType<GatewayFactory>['client'],
        connect: async token => { connected.push(token); handlers.onStatus({ kind: 'connected', appId: 'test#0001' }); }, destroy: async () => {
          if (host.channelControl.account.captureImAccountGeneration() === null) expect(connections.transport.host.secrets.write('discord-bot-token', 'late-token')).toBe(false);
        } };
    } } });
    const configuration = new TerminalConfiguration(host.capabilities, undefined, {
      revision: () => connections.version(), save: async (id, value, context) => { expect(id).toBe('discord'); context.assertCurrent?.(); await connections.invoke('discordBot:set-config', value); },
    });
    try {
      await connections.start();
      const token = 'synthetic-discord-token-not-a-real-credential';
      await configuration.save({ collectionId: 'channels', actionId: 'edit', resourceId: 'discord' }, { token, ownerUserId: 'owner' }, { source: 'local', assertCurrent: guard });
      expect(connected).toEqual([token]);
      expect(JSON.stringify(await connections.invoke('discordBot:get-status', undefined))).not.toContain(token);
      const persisted = new TerminalSecretStore(path.join(root, 'vault')); await persisted.open();
      expect(persisted.getSync('discord-bot-token')).toBe(token); persisted.lock();
      const media = connections.transport.host.media!;
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7xkAAAAASUVORK5CYII=', 'base64');
      const cached = await media.cacheImage({ integration: 'discord', token: 'attachment-1', buffer: png, mimeType: 'image/png', staging: true });
      expect(await readFile(cached.absPath)).toEqual(png);
      expect(await media.getCachedImage('discord', 'attachment-1', { shouldReuse: () => false })).toBeNull();
      expect(await media.getCachedImage('discord', 'attachment-1')).toMatchObject({ url: cached.url });
      await cached.discard?.();
      expect(await media.getCachedImage('discord', 'attachment-1')).toBeNull();
      inbound.onDmMessage({ id: 'incoming', content: 'hello through Discord', author: { id: 'owner' }, channelId: 'dm-owner', attachments: [], stickers: [] } as unknown as Parameters<typeof inbound.onDmMessage>[0]);
      await vi.waitFor(() => expect(JSON.stringify(output)).toContain('Echo:'));
      expect(native.sent).toHaveLength(1);
      expect((await host.storage.list()).find(row => row.source === 'discord')).toMatchObject({ imUserId: 'owner', imBotContextId: 'test-app', workspaceKind: 'dialogue' });
      secrets.setSync('discord-bot-runtime-active', 'synthetic-active-marker');
      await connections.close(); current = false;
      expect(secrets.getSync('discord-bot-runtime-active')).toBeNull();
      expect(secrets.getSync('discord-bot-token')).toBe(token);
      await expect(media.cacheImage({ integration: 'discord', token: 'late', buffer: png, mimeType: 'image/png' })).rejects.toThrow('IM_ACCOUNT_SCOPE_CLOSED');
      await expect(connections.invoke('discordBot:set-config', { token: 'late', ownerUserId: 'intruder' })).rejects.toThrow('IM_ACCOUNT_SCOPE_CLOSED');
    } finally { await connections.close(); configuration.close(); secrets.lock(); }
  });
  // The transport callbacks enter the production command/card/turn composition.
  // Telegram must retain topic history while /new rotates to a distinct task.
  // Only the Bot API and native engine I/O are substituted (integration tier).
  it('runs Telegram polling, topic history, settings and task rotation in the terminal host', async () => {
    const { host, native, root } = await setup();
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'telegram');
    const secrets = new TerminalSecretStore(path.join(root, 'vault')); await secrets.open(); await secrets.initialize('machine');
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let receive: ((updates: unknown[]) => void) | undefined, sequence = 1000;
    let secondReply!: () => void;
    const secondReplySent = new Promise<void>(resolve => { secondReply = resolve; });
    const api: import('@cindy/im').TelegramApiClient = {
      fileUrl: file => `https://files.invalid/${file}`,
      callForm: async () => { throw new Error('UNEXPECTED_UPLOAD'); },
      call: async (method, params = {}, signal) => {
        calls.push({ method, params });
        if (JSON.stringify(params).includes('Echo:') && JSON.stringify(params).includes('new topic task')) secondReply();
        if (method === 'getMe') return { id: 999, is_bot: true, first_name: 'Cindy', username: 'terminal_cindy_bot' } as never;
        if (method === 'getUpdates') return new Promise((resolve, reject) => {
          const abort = () => { receive = undefined; reject(new Error('aborted')); };
          receive = updates => { signal?.removeEventListener('abort', abort); receive = undefined; resolve(updates as never); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
        if (method.startsWith('send')) return { message_id: ++sequence, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id), type: Number(params.chat_id) < 0 ? 'supergroup' : 'private' } } as never;
        return {} as never;
      },
    };
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit() {}, secrets: {
      getSync: key => secrets.getSync(key), setSync: (key, value) => secrets.setSync(key, value), deleteSync: key => secrets.deleteSync(key), available: () => !secrets.status().locked,
    } }, { telegram: { apiFactory: () => api } });
    const configuration = new TerminalConfiguration(host.capabilities, undefined, { revision: () => connections.version(), save: (id, input) => connections.saveConfiguration(id, input) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, host, configuration);
    const context = { controllerDeviceId: 'terminal' }, client = { protocolVersion: 1, primitives: ['text', 'form', 'actions'], locale: 'zh-CN' };
    const resourceRef = { collectionId: 'channels', kind: 'im-channel', id: 'telegram' };
    const push = async (id: number, text: string, topic = 77, owner = true) => {
      await vi.waitFor(() => expect(receive).toBeTypeOf('function'));
      receive!([{ update_id: id, message: { message_id: id, message_thread_id: topic, is_topic_message: true, date: Math.floor(Date.now() / 1000), text,
        chat: { id: -100, type: 'supergroup', title: 'Terminal group' }, from: { id: owner ? 111 : 222, is_bot: false, first_name: owner ? 'Owner' : 'Alice' },
        ...(text.startsWith('@terminal_cindy_bot') ? { entities: [{ type: 'mention', offset: 0, length: '@terminal_cindy_bot'.length }] } : {}),
      } }]);
    };
    try {
      await connections.start();
      await connections.saveConfiguration('telegram', { token: '999:synthetic-token', ownerUserId: '111' });
      expect(connections.telegram.getStatus().kind).toBe('connected');
      expect(calls).toContainEqual({ method: 'setMyCommands', params: { scope: { type: 'chat', chat_id: 111 }, commands: expect.arrayContaining([{ command: 'new', description: 'Create a new session' }]) } });
      const view = await registry.get(context, { client, ref: resourceRef });
      expect(view.actions?.find(action => action.id === 'edit')?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'token', kind: 'secret' })]));
      expect(JSON.stringify(view)).not.toContain('synthetic-token');
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'persona', input: { botName: 'Terminal helper', soul: 'Shared persona fixture' } });
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'behavior', input: { emojiReactions: 'off' } });
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'permissions', input: { permissionMode: 'ask', groupPermissionMode: 'ask' } });
      expect(host.channelDefaults.read('telegram').groupPermissionMode).toBe('ask');
      await push(1, 'topic history amber-47', 77, false);
      await vi.waitFor(async () => expect(await connections.groups.search({ lane: { provider: 'telegram-personal:999', chatId: '-100', threadId: '77' }, query: 'amber' })).toHaveLength(1));
      await push(2, '@terminal_cindy_bot recall topic history');
      await vi.waitFor(() => expect(native.sent).toHaveLength(1));
      expect(JSON.stringify(native.sent[0])).toContain('amber-47');
      expect(JSON.stringify(native.sent[0])).toContain('Shared persona fixture');
      await vi.waitFor(() => expect(JSON.stringify(calls)).toContain('Echo:'));
      const first = (await host.storage.list()).find(row => row.source === 'telegram')!;
      expect(first.imUserId).toBe('g/-100/77');
      expect(native.inputs.find(input => input.taskId === first.id)?.tools?.providers.map(provider => provider.name)).toEqual(expect.arrayContaining(['cindy_telegram_bot', 'cindy_group_history']));
      await push(3, '/new');
      await vi.waitFor(async () => expect((await host.storage.list()).filter(row => row.source === 'telegram')).toHaveLength(2));
      await push(4, '@terminal_cindy_bot new topic task');
      // Observe completion instead of racing a one-second poll against native
      // task teardown and filesystem work on slower CI hosts.
      await secondReplySent;
      expect(native.sent).toHaveLength(2);
      const latest = (await host.storage.list()).filter(row => row.source === 'telegram').find(row => row.id !== first.id)!;
      expect(latest.imUserId).toBe(first.imUserId);
      expect(await connections.invoke('telegramBot:list-groups', undefined)).toMatchObject({ groups: [{ chatId: '-100', activation: 'mention' }] });
      await connections.close();
      const { TerminalTelegramSettings } = await import('../im/telegram-settings.js');
      const settings = new TerminalTelegramSettings(root, () => {}); await settings.ready;
      expect(settings.persona().botName).toBe('Terminal helper'); expect(settings.behavior().emojiReactions).toBe('off'); await settings.close();
    } finally { await connections.close(); configuration.close(); secrets.lock(); }
  });
  // Integration: actual Feishu adapter/orchestrator, task runtime and SQLite
  // receipts. SDK sends/history and native engine processes are the I/O seams.
  it('routes Feishu history and durable notification replies through the terminal host', async () => {
    const { host, native, root, vault } = await setup(engine(async (input, options) => {
      const provider = input.tools?.providers.find(item => item.name === 'cindy_feishu_bot');
      if (provider) await provider.toClaudeSdkConfig!({ sessionId: options.sessionId, workingDir: root, agentKind: 'claude-code' });
    }));
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'feishu');
    const auxiliary=await auxiliaryFixture(host, async () => 'RELATED');
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit() {}, secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } });
    const im = connections.feishu, output: string[] = [];
    const spies = [
      vi.spyOn(im, 'getStatus').mockReturnValue({ kind: 'connected', appId: 'cli_fixture' }),
      vi.spyOn(im, 'getOwnerOpenId').mockReturnValue('ou_owner'),
      vi.spyOn(im, 'getChatName').mockResolvedValue('Terminal group'),
      vi.spyOn(im, 'reactToMessage').mockResolvedValue(null),
      vi.spyOn(im, 'sendText').mockImplementation(async (_id, text) => { output.push(text); return { messageId: 'sent' }; }),
      vi.spyOn(im, 'sendMarkdownText').mockImplementation(async (_id, text) => { output.push(text); return { messageId: 'sent' }; }),
      vi.spyOn(im, 'startStreamingText').mockImplementation(async () => ({ messageId: 'stream', append() {}, replace() {}, close() {}, finalize: async text => { output.push(text); } })),
      vi.spyOn(im, 'fetchChatHistoryPage').mockResolvedValue({ messages: [{ messageId: 'om_history', threadId: '', senderName: 'Alice', senderOpenId: 'ou_member', senderIsBot: false, text: 'feishu-context-violet-83', attachments: [], createTimeMs: Date.now() }], nextPageToken: null }),
      vi.spyOn(im, 'sendNotification').mockResolvedValue({ messageId: 'om_notification', chatId: 'oc_owner' }),
    ];
    const event = (text: string): IMMessageEvent => ({ channelName: 'feishu', senderId: 'g/oc_group', contextId: 'cli_fixture', chatId: 'oc_group', messageId: 'om_trigger', text, attachments: [], unsupported: [], speaker: { id: 'ou_owner', name: 'Owner', isOwner: true } });
    try {
      await connections.start();
      im.scope.events.emit('message', event('recall the previous group message'));
      await vi.waitFor(() => expect(output.some(text => text.includes('Echo:'))).toBe(true));
      expect(JSON.stringify(native.sent)).toContain('feishu-context-violet-83');
      expect(JSON.stringify(auxiliary.requests)).toContain('RELATED');
      const task = (await host.storage.list()).find(row => row.source === 'feishu')!;
      expect(task).toMatchObject({ imUserId: 'g/oc_group', imBotContextId: 'cli_fixture' });
      expect(native.inputs.find(input => input.taskId === task.id)?.tools?.providers.map(provider => provider.name)).toContain('cindy_feishu_bot');
      await expect(connections.notifications.sendFeishuSessionNotification(im, task.id, 'finished')).resolves.toMatchObject({ sessionLinked: true });
      const reply = { ...event('continue original notification task'), senderId: 'ou_owner', chatId: 'oc_owner', speaker: undefined, messageId: 'om_reply', replyThread: { rootMessageId: 'om_notification', threadId: 'omt_notification' } };
      im.scope.events.emit('message', reply);
      await vi.waitFor(() => expect(output.some(text => text.includes('continue original notification task'))).toBe(true));
      expect(await host.storage.list()).toHaveLength(1);
      const originalSdk = task.sdkSessionId;
      expect((await host.storage.get(task.id))?.sdkSessionId).toBe(originalSdk);
      const ordinary = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
      const tools = native.inputs.find(input => input.taskId === ordinary.id)!.tools!;
      const provider = tools.providers.find(item => item.name === 'cindy_feishu_bot')!;
      const sdk = await provider.toClaudeSdkConfig!({ sessionId: ordinary.id, workingDir: root, agentKind: 'claude-code' }) as { instance: McpServer };
      const [left, right] = InMemoryTransport.createLinkedPair();
      const client = new McpClient({ name: 'feishu-terminal-test', version: '1' });
      await sdk.instance.connect(left); await client.connect(right);
      try {
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('send_text');
        vi.mocked(im.sendNotification).mockResolvedValueOnce({ messageId: 'om_mcp', chatId: 'oc_owner' });
        const result = await client.callTool({ name: 'call_tool', arguments: { name: 'send_message_to_user', args: { text: 'terminal task completed' } } });
        expect(JSON.stringify(result)).toContain('om_mcp'); expect(result.isError).not.toBe(true);
        expect(await connections.notifications.resolveFeishuNotificationReply(im, { ...reply, replyThread: { ...reply.replyThread!, rootMessageId: 'om_mcp' } })).toBe(ordinary.id);
      } finally { await client.close(); }
      // Keep receipts across a daemon restart and isolate another bot
      // even when it returns the same message and owner identifiers.
      await connections.close();
      const restored = new TerminalGroupWindows(root, () => {}, logger);
      try {
        const store = restored.notificationStore(async id => { const row = await host.storage.get(id); return row ? { workingDir: row.workDir, status: 'active' } : null; });
        expect(await store.find({ channel: 'feishu', botContextId: 'cli_fixture', userId: 'ou_owner', messageId: 'om_notification', chatId: 'oc_owner' })).toEqual({ sessionId: task.id });
        expect(await store.find({ channel: 'feishu', botContextId: 'another-bot', userId: 'ou_owner', messageId: 'om_notification', chatId: 'oc_owner' })).toBeNull();
      } finally { await restored.close(); }
      await expect(connections.notifications.resolveFeishuNotificationReply(im, reply)).rejects.toThrow('account changed');
    } finally { await connections.close(); for (const spy of spies) spy.mockRestore(); await auxiliary.close(); }
  });
  // The transport callbacks enter the production command/card/turn composition.
  // Regression: a successful picker must affect the next native turn and remain
  // durable; an invalid picker or a logged-out callback must not replace it.
  it('runs inbound messages and model cards through the terminal channel composition', async () => {
    const { host, native, root, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'card-provider', name: 'Card provider', auth: { method: 'none' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'card-model', name: 'Card model', contextWindow: 200000, defaultEnabled: true }] } } }]);
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'feishu');
    let inbound!: (event: IMMessageEvent) => void;
    let action!: (event: IMCardActionEvent) => void;
    const cards: InteractiveCardSpec[] = [];
    const final: string[] = [];
    const unsubscribed: string[] = [];
    const im: RichChannelIM = {
      name: 'feishu', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: handler => { inbound = handler; return () => { unsubscribed.push('message'); }; },
      onCardAction: handler => { action = handler; return () => { unsubscribed.push('card'); }; },
      onStatusChange: () => () => {},
      sendText: async (_id, text) => { final.push(text); return { messageId: 'text' }; },
      sendMarkdownText: async (_id, text) => { final.push(text); return { messageId: 'markdown' }; },
      sendFile: async () => ({ ok: true, messageId: 'file' }),
      sendInteractiveCard: async (_id, card) => { cards.push(card); return { messageId: 'picker' }; },
      updateInteractiveCard: async (_id, card) => { cards.push(card); },
      patchMarkdownCard: async (_id, text) => { final.push(text); },
      startStreamingText: async () => ({ messageId: 'stream', append() {}, replace() {}, close() {}, finalize: async text => { final.push(text); } }),
    };
    const connection = host.channelOrchestrators.attach({
      channel: 'feishu', im, output: { kind: 'rich-card', im }, ui: wechatUi,
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' },
      sessions: { source: 'feishu', sessionIdFor: (bot, user) => `feishu_${bot}_${user}`, defaultTitle: () => 'Card task', ensureWorkingDir: () => root, extraInsertColumns: () => ({}) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'feishu' }),
    });
    const message = (text: string): IMMessageEvent => ({ channelName: 'feishu', senderId: 'owner', contextId: 'bot', chatId: 'dm', messageId: text, text, attachments: [], unsupported: [] });
    inbound(message('remember the card context'));
    await vi.waitFor(() => expect(final.some(text => text.includes('Echo:'))).toBe(true));
    const id = (await connection.repo.peekSession('bot', 'owner'))!.id;
    const originalSdk = (await host.storage.get(id))!.sdkSessionId;
    inbound(message('/model'));
    await vi.waitFor(() => expect(JSON.stringify(cards)).toContain('card-model'));
    const pick: IMCardActionEvent = { channelName: 'feishu', senderId: 'owner', chatId: 'dm', messageId: 'picker', buttonId: 'model:pick', payload: { sessionId: id, modelId: 'card-model', providerId: 'card-provider', effort: 'high' } };
    await action(pick);
    inbound(message('continue after card selection'));
    await vi.waitFor(() => expect(final.some(text => text.includes('continue after card selection'))).toBe(true));
    expect(native.inputs.at(-1)?.selection).toMatchObject({ model: 'card-model', providerId: 'card-provider' });
    expect(originalSdk).toBeTruthy();
    expect(native.starts.at(-1)?.resumeSessionId).toBe(originalSdk);
    expect(JSON.stringify(await host.invoke('local-db:messages:list', [id, { limit: 20 }]))).toContain('remember the card context');
    expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBe(true);
    await action({ ...pick, payload: { ...pick.payload, modelId: 'not-a-real-model' } });
    expect((await host.storage.get(id))?.model).toBe('card-model');
    expect((await host.invoke('maker:get-session-agent-switch-intent', [id]))).toBeNull();
    const identity = { channel: 'feishu', botContextId: 'bot', userId: 'owner' };
    await host.channelBindings.store.attach(identity, id);
    expect(await host.invoke('binding:resolve-session', [id])).toMatchObject({ attached: true, identity });
    expect(await host.invoke('binding:revoke', [id])).toEqual({ ok: true, alreadyDetached: false });
    expect(await host.invoke('binding:list-attached')).toEqual({ sessionIds: [] });
    await host.close();
    expect(unsubscribed.sort()).toEqual(['card', 'message']);
    const sent = native.sent.length;
    await action({ ...pick, payload: { ...pick.payload, modelId: 'test-model', providerId: 'fixture' } });
    inbound(message('stale callback after logout'));
    const restored = create(); await restored.ready;
    expect((await restored.storage.get(id))?.model).toBe('card-model');
    expect(native.sent).toHaveLength(sent);
    await connection.close();
  });
  // Real runner/send lane: configuration changes follow, while an explicit
  // same-value GUI choice persists across restart and ends automatic following.
  it('follows channel model defaults with context and preserves an explicit task override after restart', async () => {
    const fixture = await setup();
    let host = fixture.host;
    await host.invoke('maker:provider:custom:create', [{ id: 'channel-codex', name: 'Channel Codex', auth: { method: 'none' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [
      { id: 'channel-one', name: 'One' }, { id: 'channel-two', name: 'Two' },
    ] } } }]);
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'wechat');
    const im: TextChannelIM = {
      name: 'wechat', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: () => () => {}, onStatusChange: () => () => {},
      sendText: async () => ({ messageId: 'notice' }), sendMarkdownText: async () => ({ messageId: 'notice' }),
      sendFile: async () => ({ ok: true, messageId: 'file' }),
    };
    const adapter: ImChannelAdapter = {
      channel: 'wechat', im, output: { kind: 'chunked-text', im, commitFinal: async () => {} },
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' }, ui: wechatUi,
      sessions: { source: 'wechat', sessionIdFor: (bot, user) => `wechat_${bot}_${user}`, defaultTitle: () => 'Channel task', ensureWorkingDir: () => fixture.root, extraInsertColumns: () => ({}) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'wechat' }),
    };
    function openRunner() {
      const repo = host.channelRepository(adapter.config, adapter.sessions);
      const runner = createTurnRunner(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), host.channelTurnDependencies({
        source: 'wechat', config: adapter.config, isRouteUsable: route => runner.hasAuthForRoute(route),
      }), host.channelTurnHost());
      return runner;
    }
    let runner = openRunner();
    async function send(text: string) {
      const result = await runner.dispatchAgentTurn({ botContextId: 'bot', userId: 'owner', userMessageId: text, text, attachments: [], queueMode: 'external', beforeProviderStart: async () => {} });
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') throw new Error(result.reason);
      expect((await result.terminal).kind).toBe('done');
      return result.sessionId;
    }
    try {
      const id = await send('channel context before switching');
      await host.channelDefaults.update({ agentKind: 'codex', agents: { codex: { model: 'channel-one', providerId: 'channel-codex', effort: 'high' } } }, 'wechat');
      expect(await send('follow the configured model')).toBe(id);
      expect((await host.storage.get(id))?.agentKind).toBe('codex');
      expect(JSON.stringify(fixture.native.sent.at(-1))).toContain('channel context before switching');
      expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBeUndefined();
      await host.invoke('maker:set-model', [id, 'channel-one', 'channel-codex']);
      await send('keep this explicit model');
      expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBe(true);
      await runner.disposeAllSessions();
      await host.close();
      host = fixture.create(); await host.ready;
      await host.channelDefaults.update({ agents: { codex: { model: 'channel-two', providerId: 'channel-codex', effort: 'high' } } }, 'wechat');
      runner = openRunner();
      expect(await send('continue after restart')).toBe(id);
      expect(fixture.native.inputs.at(-1)?.selection.model).toBe('channel-one');
      expect((await host.storage.get(id))?.model).toBe('channel-one');
      const repo = host.channelRepository(adapter.config, adapter.sessions);
      const slash = createSlashHandlers(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), runner, host.channelControl.commands);
      expect(await slash.handleSlashCommand('/new', { botContextId: 'bot', userId: 'owner' })).toBe(true);
      const reset = await host.storage.get(id);
      expect(reset).toMatchObject({ model: 'channel-two' });
      expect(reset?.sdkSessionId).toBeUndefined();
      expect(reset?.pendingHandoff).toBeUndefined();
      expect(JSON.parse(reset!.imDefaultRoute!).manual).toBeUndefined();
      expect(await send('start fresh with the channel default')).toBe(id);
      expect(fixture.native.starts.at(-1)?.resumeSessionId).toBeUndefined();
      expect(JSON.stringify(fixture.native.sent.at(-1))).not.toContain('channel context before switching');
    } finally { await runner.disposeAllSessions(); }
  });
  // Real remote-agent controller/host on two isolated task owners. Only the
  // authenticated transport and upstream vendor process are fixture adapters.
  it('moves an existing task to another agent computer and back without moving its workspace', async () => {
    const remote = await setup();
    await remote.host.invoke('maker:provider:custom:create', [{ id: 'remote-fixture', name: 'Remote fixture', auth: { method: 'none' }, runtimes: { pi: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'remote-model', name: 'Remote model', contextWindow: 200000 }] } } }]);
    const agents = new TerminalRemoteAgentService({ profileDir: remote.root, getOwnerScope: () => 'owner', readProviders: () => remote.host.models.views(), startHosted: input => remote.host.startHosted(input), isAgentAvailable: kind => remote.host.isAgentAvailable(kind) });
    try {
      await agents.setEnabled('remote-fixture', true, () => {});
      const local = await setup(engine(), { remoteInvoke: async (device, channel, args) => {
        expect(device).toBe('execution-computer');
        if (channel === 'maker:provider:list') return { ok: true, result: { providers: await agents.views() } };
        expect(channel).toBe(REMOTE_AGENT_CHANNEL);
        return { ok: true, result: await agents.request(args[0], { source: { kind: 'owner', deviceId: 'task-computer', peerId: 'task-computer' }, controllerDeviceId: 'task-computer', sourceDeviceId: 'task-computer', ownerScope: 'owner', requestId: 'fixture-request', signal: new AbortController().signal, assertCurrent() {} }) };
      } });
      const task = await local.host.invoke('maker:create-session', [{ workingDir: local.root }]) as { id: string };
      await local.host.invoke('maker:send', [task.id, { text: 'work stays on this computer', clientId: 'local-input' }]);
      await local.host.invoke('terminal:tasks:wait', [task.id, 'local-input']);
      await local.host.invoke('maker:switch-session-agent', [task.id, 'pi', 'remote-model', 'remote-fixture', undefined, undefined, { agentDeviceId: 'execution-computer' }]);
      await local.host.invoke('maker:send', [task.id, { text: 'run on the other computer', clientId: 'remote-input' }]);
      expect(await local.host.invoke('terminal:tasks:wait', [task.id, 'remote-input'])).toMatchObject({ status: 'completed' });
      expect(remote.native.sent).toHaveLength(1);
      expect(JSON.stringify(remote.native.sent[0])).toContain('work stays on this computer');
      expect((await local.host.storage.get(task.id))?.workDir).toBe(local.root);
      expect(remote.native.starts[0].deviceHosted?.workingDir).toBeTruthy();
      await local.host.invoke('maker:switch-session-agent', [task.id, 'claude-code', 'test-model', 'fixture', undefined, undefined, { agentDeviceId: null }]);
      await local.host.invoke('maker:send', [task.id, { text: 'back on this computer', clientId: 'back-input' }]);
      expect(await local.host.invoke('terminal:tasks:wait', [task.id, 'back-input'])).toMatchObject({ status: 'completed' });
      expect(local.native.sent).toHaveLength(2);
      expect(JSON.stringify(local.native.sent.at(-1))).toContain('run on the other computer');
      expect((await local.host.storage.get(task.id))?.agentDeviceId).toBeUndefined();
      // Same production controller/host path for a companion, with no local
      // engine installed. Remote location and private workspace must survive.
      const companion=new TerminalCompanionHost({root:path.join(local.root,'companions'),profileDir:local.root,models:local.host.models,logger,guard(){},emit(){},
        binary:async()=>null,createAgent:local.native.create,
        providerViews:device=>local.host.companionProviderViews(device),
        resolveModel:(choice,id,dir)=>local.host.resolveCompanionModel(choice,id,dir),
        deviceStarter:(tools,memory)=>local.host.companionDeviceStarter(tools,memory)});
      try {
        await companion.modelSettings.saveDefaults([{agentKind:'pi',providerId:'model-route:'+JSON.stringify(['execution-computer','remote-fixture']),model:'remote-model',fastMode:false}]);
        const profile=await companion.create({name:'Remote companion'});
        await (await companion.send(profile.id,'companion on execution computer','companion-remote')).completion;
        expect(local.native.sent).toHaveLength(2);
        expect(remote.native.sent).toHaveLength(2);
        expect(remote.native.starts.at(-1)?.botProfilePrompt).toContain('Remote companion');
        expect(remote.native.starts.at(-1)?.deviceHosted?.mcpServers).toContain('cindy_memory');
        expect(await companion.storage.get(profile.sessionId)).toMatchObject({agentDeviceId:'execution-computer',providerId:'remote-fixture',workDir:path.join(companion.profiles.home(profile.id),'workspace')});
        await companion.stop(profile.id);
        await agents.setEnabled('remote-fixture',false,()=>{});
        await expect(companion.send(profile.id,'must not run locally','revoked-remote').then(receipt=>receipt.completion)).rejects.toThrow();
        expect(local.native.sent).toHaveLength(2);
      } finally {await companion.close();}
      await local.host.close();
    } finally { await agents.stop(); }
    // Shutdown must drain removal of private hosted instructions before the
    // profile can be closed or removed, without racing a second filesystem pass.
    expect(remote.native.starts).toHaveLength(2);
    for (const start of remote.native.starts) await expect(access(start.workingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // The released SET_MODEL channel must preserve Codex's native compaction,
  // and rebuild Claude/Pi context before a smaller model receives the next turn.
  it.each(['claude-code', 'codex', 'pi'] as const)('protects smaller model windows through the real %s send boundary', async kind => {
    const { host, native, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'window-fixture', name: 'Window fixture', auth: { method: 'none' }, runtimes: { [kind]: { baseUrl: 'http://127.0.0.1:1', models: [
      { id: 'big-model', name: 'Big', contextWindow: 200000 }, { id: 'small-model', name: 'Small', contextWindow: 100000 },
    ] } } }]);
    native.usageByModel.set('big-model', { contextTokens: 180000, contextWindow: 200000 });
    const task = await host.invoke('maker:create-session', [{ agentKind: kind, providerId: 'window-fixture', model: 'big-model' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'keep the original task', clientId: 'big-input' }]);
    await host.invoke('terminal:tasks:wait', [task.id, 'big-input']);
    const original = (await host.storage.get(task.id))!.sdkSessionId;
    await host.close();
    const restored = create(); await restored.ready;
    expect(await restored.invoke('maker:set-model', [task.id, 'small-model', 'window-fixture'])).toMatchObject({ deferred: true });
    expect((await restored.storage.get(task.id))!.model).toBe('big-model');
    await restored.invoke('maker:send', [task.id, { text: 'continue in the smaller model', clientId: 'small-input' }]);
    expect(await restored.invoke('terminal:tasks:wait', [task.id, 'small-input'])).toMatchObject({ status: 'completed' });
    expect(native.inputs.at(-1)?.selection.model).toBe('small-model');
    const rebuilt = kind !== 'codex';
    expect(native.starts.at(-1)?.resumeSessionId).toBe(rebuilt ? undefined : original);
    if (rebuilt) expect(JSON.stringify(native.sent.at(-1))).toContain('keep the original task');
    const messages = await restored.invoke('local-db:messages:list', [task.id, { limit: 100 }]) as Array<{ role: string; content: string; agentMeta?: { contextRebuild?: unknown } }>;
    expect(messages.filter(message => message.agentMeta?.contextRebuild)).toHaveLength(rebuilt ? 1 : 0);
    expect(messages.some(message => message.role === 'context_rebuild')).toBe(false);
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['continue in the smaller model', 'keep the original task']);
  });
  it('does not send on the old route when a queued engine choice is disabled', async () => {
    const { host, native } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'disabled-fixture', name: 'Disabled fixture', auth: { method: 'none' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'disabled-model', name: 'Model' }] } } }]);
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:switch-session-agent', [task.id, 'codex', 'disabled-model', 'disabled-fixture']);
    await host.invoke('maker:model-disable:set', [{ kind: 'model', providerId: 'disabled-fixture', modelIds: ['disabled-model'], disabled: true }]);
    await host.invoke('maker:send', [task.id, { text: 'only use the selected model', clientId: 'disabled-input' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'disabled-input'])).toMatchObject({ status: 'failed', error: 'TASK_MODEL_SWITCH_NOT_READY' });
    expect(native.sent).toHaveLength(0);
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toMatchObject({ targetAgentKind: 'codex' });
    expect(await host.invoke('local-db:messages:list', [task.id])).toEqual([]);
  });
  it('rebuilds a failed native context before the next user send without replaying a failed input', async () => {
    const { host, native, create } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    for (const text of ['completed earlier work', 'context-overflow-fixture']) {
      await host.invoke('maker:send', [task.id, { text, clientId: text.replaceAll(' ', '-') }]);
      await host.invoke('terminal:tasks:wait', [task.id, text.replaceAll(' ', '-')]);
    }
    await host.close(); const restored = create(); await restored.ready;
    await restored.invoke('maker:send', [task.id, { text: 'continue now', clientId: 'new-input' }]);
    expect(await restored.invoke('terminal:tasks:wait', [task.id, 'new-input'])).toMatchObject({ status: 'completed' });
    expect(native.starts.at(-1)?.resumeSessionId).toBeUndefined();
    expect(JSON.stringify(native.sent.at(-1))).toContain('completed earlier work');
    expect(JSON.stringify(native.sent.at(-1))).not.toContain('context-overflow-fixture');
    expect(native.sent).toHaveLength(4);
  });
  // Integration: the same submission survives automatic context rebuilding;
  // a completed tool effect or a user stop must prevent hidden replay.
  it('continues one overflowed input once and preserves its receipt and earlier history', async () => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'remember amber-47', clientId: 'earlier' }]);
    await host.invoke('terminal:tasks:wait', [task.id, 'earlier']);
    await host.invoke('maker:send', [task.id, { text: 'overflow-once', clientId: 'recover-me' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'recover-me'])).toMatchObject({ status: 'completed' });
    const history = await host.invoke('local-db:messages:list', [task.id, { limit: 100 }]) as Array<{ role: string; content: string; agentMeta?: { contextRebuild?: unknown } }>;
    expect(history.filter(row => row.agentMeta?.contextRebuild)).toHaveLength(1);
    expect(history.filter(row => row.role === 'user' && row.content === 'overflow-once')).toHaveLength(1);
    expect(history.some(row => row.role === 'error')).toBe(false);
    expect(native.sent).toHaveLength(3);
    expect(JSON.stringify(native.sent.at(-1))).toContain('amber-47');
    expect(native.starts.at(-1)?.resumeSessionId).toBeUndefined();
  });
  it('surfaces overflow after a tool effect without replaying the input', async () => {
    const { host, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'overflow-after-write', clientId: 'no-repeat' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'no-repeat'])).toMatchObject({ status: 'failed' });
    expect(native.sent).toHaveLength(1);
    expect(await readFile(path.join(root, 'effect.txt'), 'utf8')).toBe('completed once');
    expect((await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string }>).some(row => row.role === 'error')).toBe(true);
  });
  it.each(['scheduler', 'session'] as const)('returns overflow to its %s dispatcher without leaving the receipt running', async source => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    if (source === 'scheduler') {
      await host.submitScheduled(task.id, 'overflow-once', { scheduleId: 'schedule-1', scheduleName: 'Fixture', runId: 'run-1', requestId: 'external-input' });
    } else {
      await host.invoke('maker:send', [task.id, { text: 'overflow-once', clientId: 'external-input' }], { source: 'local', sender: { sessionId: 'sender-1', title: 'Sender' } });
    }
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'external-input'])).toMatchObject({ status: 'failed' });
    expect(native.sent).toHaveLength(1);
    const history = await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; agentMeta?: { origin?: { kind: string }; contextRebuild?: unknown } }>;
    expect(history.find(row => row.role === 'user')?.agentMeta?.origin?.kind).toBe(source);
    expect(history.some(row => row.agentMeta?.contextRebuild)).toBe(false);
  });
  it.each(['maker:input:stop', 'maker:close-session', 'maker:abort-session'])('cancels an in-flight rebuild before its commit through %s', async command => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = host.storage.commitContextRebuild.bind(host.storage);
    const commit = vi.spyOn(host.storage, 'commitContextRebuild').mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
    try {
      await host.invoke('maker:send', [task.id, { text: 'overflow-once', clientId: 'cancel-me' }]);
      await entered;
      await host.invoke('maker:send', [task.id, { text: 'queued input', clientId: 'still-queued' }]);
      const stop = host.invoke(command, [task.id]);
      release(); await stop;
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'cancel-me'])).toMatchObject({ status: 'interrupted' });
      expect(native.sent).toHaveLength(1);
      expect((await host.invoke('local-db:messages:list', [task.id]) as Array<{ agentMeta?: { contextRebuild?: unknown } }>).some(row => row.agentMeta?.contextRebuild)).toBe(false);
      expect(await host.invoke('maker:session-in-turn', [task.id])).toBe(false);
      expect(await host.invoke('terminal:tasks:status', [task.id, 'still-queued'])).toMatchObject({ status: 'queued' });
    } finally { release(); commit.mockRestore(); }
  });
  // The public GUI channel stages a choice; the real Maker send boundary applies
  // it, records context, and resumes the parked native engine when switching back.
  it.each([false, true])('applies a queued engine choice and returns to its parked engine (expired: %s)', async expired => {
    const { host, native, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'codex-fixture', name: 'Codex fixture', auth: { method: 'apiKey' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'codex-model', name: 'Codex model', contextWindow: 200000 }] } } }, { codex: 'invalid-codex-key-only' }]);
    const task = await host.invoke('maker:create-session', [{ title: 'Engine switch' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'remember the original work' }]);
    const original = (await host.storage.get(task.id))?.sdkSessionId;
    expect(await host.invoke('maker:switch-session-agent', [task.id, 'codex', 'codex-model', 'codex-fixture'])).toMatchObject({ deferred: true });
    expect((await host.storage.get(task.id))?.agentKind).toBe('claude-code');
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toMatchObject({ targetAgentKind: 'codex', model: 'codex-model' });
    await host.invoke('maker:send', [task.id, { text: 'continue with Codex', clientId: 'switched-message' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'switched-message'])).toMatchObject({ status: 'completed' });
    await host.storage.flush();
    expect(native.inputs.at(-1)?.selection.agentKind).toBe('codex');
    expect(JSON.stringify(native.sent.at(-1))).toContain('remember the original work');
    expect((await host.storage.get(task.id))?.agentKind).toBe('codex');
    expect((await host.storage.submission(task.id, 'switched-message'))?.status).toBe('completed');
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toBeNull();
    await host.close();
    const restarted = create(); await restarted.ready;
    if (expired) native.resumeFailures.add(original!);
    await restarted.invoke('maker:switch-session-agent', [task.id, 'claude-code', 'test-model', 'fixture']);
    await restarted.invoke('maker:send', [task.id, { text: 'return to the original engine' }]);
    expect(native.starts.at(-1)?.resumeSessionId).toBe(expired ? undefined : original);
    if (expired) expect(JSON.stringify(native.sent.at(-1))).toContain('remember the original work');
    expect(native.inputs.at(-1)?.selection.agentKind).toBe('claude-code');
    const messages = await restarted.invoke('local-db:messages:list', [task.id, { limit: 50 }]) as Array<{ role: string; content: string }>;
    expect(messages.filter(row => row.role === 'agent_switch')).toHaveLength(2);
    expect(JSON.parse(messages.find(row => row.role === 'agent_switch')!.content)).toMatchObject({ fromAgentKind: 'codex', toAgentKind: 'cc', resumed: !expired });
    expect(messages.filter(row => row.role === 'user').map(row => row.content)).toEqual(['return to the original engine', 'continue with Codex', 'remember the original work']);
  });
  // Filesystem transaction regression: a crash after the boundary append must
  // recover its matching model and handoff, without adding a second boundary.
  it('recovers an interrupted model commit before admitting any newer task writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-route-commit-')); roots.push(root);
    const store = new TerminalTaskStorage(root); await store.open();
    await store.create({ id: 'task', agentKind: 'claude-code', model: 'old-model', workDir: root, title: 'Task' });
    const boundary = { fromAgentKind: 'cc' as const, toAgentKind: 'codex' as const, fromModel: 'old-model', toModel: 'new-model', fromSdkSessionId: 'old-native', handoff: 'Preserve the previous context', consumed: false };
    const write = platform.atomicPrivateWrite;
    const failure = vi.spyOn(platform, 'atomicPrivateWrite').mockImplementation(async (file, content) => {
      if (file === path.join(root, 'task', 'task.json')) throw new Error('fixture metadata write failed');
      return write(file, content);
    });
    try {
      await expect(store.commitRouteChange('task', { agentKind: 'codex', model: 'new-model' }, boundary, () => {})).rejects.toThrow('fixture metadata write failed');
      await expect(store.append('task', { kind: 'user', message: { type: 'user', content: 'must wait for recovery' } })).rejects.toThrow('fixture metadata write failed');
      await expect(store.get('task')).rejects.toThrow('fixture metadata write failed');
    } finally { failure.mockRestore(); }
    const recovered = new TerminalTaskStorage(root); await recovered.open();
    expect(await recovered.get('task')).toMatchObject({ agentKind: 'codex', model: 'new-model', pendingHandoff: { text: boundary.handoff } });
    const records = (await recovered.history('task')).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'boundary', boundary });
    await expect(readFile(path.join(root, 'task', 'route-commit.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const fallback = { ...boundary, resumed: false, handoff: 'Full context after resume failure' };
    await recovered.commitRouteChange('task', { sdkSessionId: undefined }, fallback, () => {}, records[0].clientId);
    const restarted = new TerminalTaskStorage(root); await restarted.open();
    expect((await restarted.get('task'))?.pendingHandoff?.text).toBe(fallback.handoff);
    expect((await restarted.history('task')).records.map(row => row.kind)).toEqual(['boundary', 'boundary-meta']);
  });
  // Integration: use the real shared channel runner, Maker, task journal and
  // restart recovery. Only network delivery and the native vendor are replaced.
  it('resumes a GUI task through the shared channel runner after restart and consumes its durable handoff once', async () => {
    const { host, create, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Existing GUI task' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'before restart' }]);
    await host.storage.update(task.id, { pendingHandoff: { id: 'route-boundary', text: 'Preserved route context', createdAt: Date.now() } });
    await host.close();
    const resumed = create(); await resumed.ready;
    await resumed.channelBindings.store.attach({ channel: 'wechat', botContextId: 'bot', userId: 'owner' }, task.id);
    const delivered: ImFinalOutput[] = [];
    const notices: string[] = [];
    const im: TextChannelIM = {
      name: 'wechat', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: () => () => {}, onStatusChange: () => () => {},
      sendText: async (_user, text) => { notices.push(text); return { messageId: String(notices.length) }; },
      sendMarkdownText: async (_user, text) => { notices.push(text); return { messageId: String(notices.length) }; },
      sendFile: async () => ({ ok: true, messageId: 'file' }),
    };
    const adapter: ImChannelAdapter = {
      channel: 'wechat', im, output: { kind: 'chunked-text', im, commitFinal: async output => { delivered.push(output); } },
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' }, ui: wechatUi,
      sessions: { source: 'wechat', sessionIdFor: (bot, user) => `wechat_${bot}_${user}`, defaultTitle: () => 'Channel task', ensureWorkingDir: () => root, extraInsertColumns: () => ({}) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'wechat' }),
    };
    const repo = resumed.channelRepository(adapter.config, adapter.sessions);
    const runner = createTurnRunner(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), resumed.channelTurnDependencies(), resumed.channelTurnHost());
    let dispatches = 0;
    try {
      for (const text of ['continue remotely', 'next message']) {
        const result = await runner.dispatchAgentTurn({ botContextId: 'bot', userId: 'owner', userMessageId: text, text, attachments: [], queueMode: 'external', beforeProviderStart: async () => { dispatches++; } });
        expect(result.kind).toBe('accepted');
        if (result.kind !== 'accepted') throw new Error(result.reason);
        expect(result.sessionId).toBe(task.id);
        expect((await result.terminal).kind).toBe('done');
      }
      expect(dispatches).toBe(2);
      expect(delivered).toHaveLength(2);
      expect(JSON.stringify(delivered[0])).toContain('continue remotely');
      expect(native.starts.at(-1)?.resumeSessionId).toBe(`native-${task.id}`);
      expect(native.starts.at(-1)?.providerId).toBe('fixture');
      expect(JSON.stringify(native.sent.at(-2))).toContain('Preserved route context');
      expect(JSON.stringify(native.sent.at(-1))).not.toContain('Preserved route context');
      await resumed.taskContext.enqueue('read after acceptance', () => resumed.storage.flush());
      expect((await resumed.storage.get(task.id))?.pendingHandoff).toBeNull();
      const messages = await resumed.invoke('local-db:messages:list', [task.id, { limit: 20 }]) as Array<{ role: string; content: string; agentMeta: Record<string, unknown> | null }>;
      expect(messages.filter(row => row.role === 'user').map(row => row.content)).toEqual(['next message', 'continue remotely', 'before restart']);
      expect(messages.find(row => row.content === 'continue remotely')?.agentMeta?.imSource).toBeDefined();
      expect(notices).toEqual([]);
    } finally { await runner.disposeAllSessions(); }
    await resumed.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.channelTurnHost().agentHandoffPending.peek(task.id)).toBeNull();
  });
  // A late accepted send may only retire its own context boundary. The next
  // GUI send must still receive a newer committed boundary after restart.
  it('keeps a newer handoff when an older dispatch settles and rejects stale channel hydration', async () => {
    const { host, root, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.storage.update(task.id, { pendingHandoff: { id: 'old', text: 'old handoff', createdAt: Date.now() } });
    expect(await host.channelTurnHost().agentHandoffPending.peek(task.id)).toBe('old handoff');
    await host.storage.update(task.id, { pendingHandoff: { id: 'new', text: 'new handoff', createdAt: Date.now() } });
    host.channelTurnHost().agentHandoffPending.consume(task.id);
    await host.taskContext.enqueue('accepted context flush', () => host.storage.flush());
    expect((await host.storage.get(task.id))?.pendingHandoff?.id).toBe('new');
    await host.close();
    const resumed = create(); await resumed.ready;
    const ports = resumed.channelTurnHost();
    ports.hydrateSessionProvider(task.id, 'fixture'); ports.setSessionEffort(task.id, 'high');
    await resumed.storage.update(task.id, { effort: 'low' });
    await expect(ports.getMaker().createSession({ id: task.id, agentKind: 'claude-code', workingDir: root, model: 'test-model' })).rejects.toThrow('CHANNEL_TASK_ROUTE_CHANGED');
    await resumed.invoke('maker:send', [task.id, { text: 'GUI continues' }]);
    expect(JSON.stringify(native.sent.at(-1))).toContain('new handoff');
    expect(JSON.stringify(native.sent.at(-1))).not.toContain('old handoff');
    await resumed.taskContext.enqueue('flush GUI acceptance', () => resumed.storage.flush());
    expect((await resumed.storage.get(task.id))?.pendingHandoff).toBeNull();
    const messages = await resumed.invoke('local-db:messages:list', [task.id, { limit: 10 }]) as Array<{ role: string; content: string }>;
    expect(messages.find(row => row.role === 'user')?.content).toBe('GUI continues');
  });
  // Regression: vendor silent-stop previously completed the terminal receipt
  // immediately and could leave a shared IM turn waiting forever. Real Maker
  // drives generation, terminal and abort callbacks; only its transport is fake.
  it.each(['resume', 'stop', 'exhausted'] as const)('keeps a silent task occupied until %s settles its logical turn', async outcome => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const terminal = (silent: boolean) => new Promise<void>(resolve => {
      const off = host.observeTask(task.id, event => {
        if (event.type === 'done' && Boolean((event.data as { silentStop?: boolean })?.silentStop) === silent) { off(); resolve(); }
      });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const first = terminal(true);
      await host.invoke('maker:send', [task.id, { text: outcome === 'exhausted' ? 'silent-loop' : 'silent-once', clientId: 'silent-receipt' }]);
      await first;
      expect(await host.invoke('maker:session:turn-active', [task.id])).toEqual({ inTurn: true });
      expect((await host.storage.submission(task.id, 'silent-receipt'))?.status).not.toBe('completed');
      if (outcome === 'stop') {
        await host.invoke('maker:abort-session', [task.id]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(native.sent).toHaveLength(1);
        expect(host.isTurnRunning(task.id)).toBe(false);
      } else if (outcome === 'resume') {
        const finished = terminal(false);
        await vi.advanceTimersByTimeAsync(1_500);
        await finished;
        await host.storage.flush();
        expect(native.sent.map(message => message.content)).toEqual(['silent-once', '继续']);
        const messages = await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; agentMeta?: { autoResume?: boolean } }>;
        expect(messages.filter(message => message.agentMeta?.autoResume)).toHaveLength(1);
        expect(host.isTurnRunning(task.id)).toBe(false);
      } else {
        const repeated = terminal(true);
        await vi.advanceTimersByTimeAsync(1_500);
        await repeated;
        const settled = new Promise<string>(resolve => { const off = host.turnLifecycle.onSettled(task.id, (_id, reason) => { off(); resolve(reason); }); });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(await settled).toBe('exhausted');
        await host.storage.flush();
        expect(native.sent).toHaveLength(2);
        expect(host.isTurnRunning(task.id)).toBe(false);
      }
    } finally { vi.useRealTimers(); }
  });
  // Integration: the Desktop sidecar tests do not cover terminal send admission,
  // journal anchors, runtime capture hooks, or remote restore against live tasks.
  it('captures real turn edits for GUI restore, rejects conflicts, and preserves patches after restart', async () => {
    const { host, root, create, nextPush } = await setup();
    const file = path.join(root, 'revision.txt');
    await writeFile(file, 'before\n');
    const task = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'edit-fixture' }]);
    await host.changes.store.waitForTurnChangeSetPersistence();
    const [change] = await host.invoke('maker:turn-change-sets:list', [task.id]) as Array<{ id: string; anchorClientId: string; isReversible: boolean }>;
    expect(change.isReversible).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('after\n');
    const user = (await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; clientId: string }>).find(row => row.role === 'user');
    expect(change.anchorClientId).toBe(user!.clientId);
    const context = { source: 'remote' as const, deviceId: 'test-controller' };
    await host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context);
    expect(await readFile(file, 'utf8')).toBe('before\n');
    await host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'reapply'], context);
    expect(await readFile(file, 'utf8')).toBe('after\n');
    await writeFile(file, 'changed separately\n');
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('STALE_DIFF');
    expect(await readFile(file, 'utf8')).toBe('changed separately\n');
    const approval = nextPush('maker:interaction-request');
    const sending = host.invoke('maker:send', [task.id, { text: 'permission' }]);
    const request = await approval as { request: { requestId: string } };
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('SESSION_RUNNING');
    await host.invoke('maker:resolve-interaction', [request.request.requestId, { kind: 'permission', behavior: 'deny' }]);
    await sending;
    await host.close();
    const reopened = create(); await reopened.ready;
    expect(await reopened.invoke('maker:turn-change-sets:list', [task.id])).toMatchObject([{ id: change.id }]);
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('TASK_HOST_CLOSED');
  });
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
  // Recovery tier / IM /new: a committed rotation spans two task files and
  // the takeover file. Interrupt the real final write, then reopen production
  // storage; never accept a half-rotated task or lose a newer takeover.
  it('recovers an interrupted channel rotation with its takeover and preserves a newer binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-channel-rotation-')); roots.push(root);
    const storage = new TerminalTaskStorage(path.join(root, 'tasks')); await storage.open();
    const bindings = new TerminalImBindings({ root, logger, assertCurrent() {} }); await bindings.ready;
    const metadata = { agentKind: 'claude-code' as const, model: 'test-model', workDir: root, title: 'Channel task' };
    const old = await storage.create({ ...metadata, id: 'old-channel', sdkSessionId: 'native-context', source: 'telegram' });
    await storage.create({ ...metadata, id: 'taken-over' });
    await storage.append(old.id, { kind: 'user', message: { type: 'user', content: 'preserve original history' } });
    const identity = { channel: 'telegram', botContextId: 'bot', userId: 'owner' };
    await bindings.store.attach(identity, 'taken-over');
    const write = platform.atomicPrivateWrite;
    const interruption = vi.spyOn(platform, 'atomicPrivateWrite').mockImplementation(async (file, value) => {
      if (file === path.join(root, 'channel-bindings.json')) throw new Error('SIMULATED_PROCESS_INTERRUPTION');
      return write(file, value);
    });
    try {
      await expect(bindings.commitTaskRotation({ identity, targetSessionId: 'taken-over' }, snapshot => storage.rotateChannelTask({ ...metadata, id: 'new-channel', source: 'telegram' }, old.id, snapshot, () => {}))).rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION');
      await expect(storage.list()).rejects.toThrow('SIMULATED_PROCESS_INTERRUPTION');
      expect(bindings.store.get(identity)).toBe('taken-over');
    } finally { interruption.mockRestore(); await bindings.close(); }
    const recovered = new TerminalTaskStorage(path.join(root, 'tasks'));
    const recovery = recovered.open();
    const restoredBindings = new TerminalImBindings({ root, logger, beforeOpen: recovery, assertCurrent() {} });
    await restoredBindings.ready;
    try {
      expect(await recovered.get('new-channel')).toMatchObject({ source: 'telegram' });
      expect(await recovered.get(old.id)).toMatchObject({ archived: true, sdkSessionId: 'native-context' });
      expect((await recovered.history(old.id)).records[0].message?.content).toBe('preserve original history');
      expect(restoredBindings.store.get(identity)).toBeNull();
      await recovered.create({ ...metadata, id: 'newer-takeover' });
      await restoredBindings.store.attach(identity, 'newer-takeover');
      await restoredBindings.commitTaskRotation({ identity, targetSessionId: 'taken-over' }, snapshot => recovered.rotateChannelTask({ ...metadata, id: 'next-channel', source: 'telegram' }, 'new-channel', snapshot, () => {}));
      expect(restoredBindings.store.get(identity)).toBe('newer-takeover');
      expect(await recovered.get('new-channel')).toMatchObject({ archived: true });
    } finally { await restoredBindings.close(); }
    const after = new TerminalImBindings({ root, logger, assertCurrent() {} }); await after.ready;
    expect(after.store.get(identity)).toBe('newer-takeover'); await after.close();
  });
  // Integration: channel identity creation/revival/rotation must produce the
  // same tasks that GUI clients read and the real Maker runtime resumes.
  it('creates, revives and rotates channel tasks through the shared GUI task host', async () => {
    const { host, root, create, native, pushes } = await setup();
    const config = { agentKind: 'claude-code' as const, defaultModel: 'test-model', defaultPermissionMode: 'auto' as const };
    const namespace = { source: 'telegram' as const, createTaskOnNew: true, sessionIdFor: (bot: string, user: string) => `telegram_${bot}_${user}`, defaultTitle: () => 'Telegram task', ensureWorkingDir: () => root, workspaceKind: 'dialogue' as const, extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }) };
    await host.channelDefaults.update({ agents: { 'claude-code': { providerId: 'fixture', model: 'test-model', effort: 'high' } } }, 'telegram');
    const repo = host.channelRepository(config, namespace);
    const [first, duplicate] = await Promise.all([repo.createSession('bot', 'owner'), repo.createSession('bot', 'owner')]);
    expect(first.id).toBe(duplicate.id);
    expect(native.starts).toHaveLength(0);
    expect((await host.invoke('local-db:sessions:list', [])) as unknown[]).toHaveLength(1);
    expect(await host.invoke('local-db:sessions:get', [first.id])).toMatchObject({ source: 'telegram', workspaceKind: 'dialogue', imUserId: 'owner', imBotContextId: 'bot', userSendAt: expect.any(String) });
    const runtime = await host.channelRuntime().createSession({ id: first.id, agentKind: first.agentKind, workingDir: first.workingDir, model: first.model, vendorOptions: { source: 'telegram' } });
    await host.invoke('maker:send', [first.id, { text: 'original channel task' }]);
    const sdkSessionId = (await host.storage.get(first.id))!.sdkSessionId;
    expect(runtime).toBe(host.channelRuntime().getSession(first.id));
    await host.invoke('local-db:sessions:patch-meta', [first.id, { status: 'archived' }]);
    expect((await repo.peekSession('bot', 'owner'))?.sdkSessionId).toBe(sdkSessionId);
    expect((await host.storage.get(first.id))?.archived).toBe(true);
    expect((await repo.findActiveSession('bot', 'owner'))?.id).toBe(first.id);
    expect((await host.storage.get(first.id))?.archived).toBe(false);
    const target = await host.invoke('maker:create-session', [{ title: 'Existing GUI task' }]) as { id: string };
    const identity = { channel: 'telegram', botContextId: 'bot', userId: 'owner' };
    await host.channelBindings.store.attach(identity, target.id);
    const rotated = await repo.createFreshSession!('bot', 'owner', undefined, undefined, { identity, targetSessionId: target.id });
    expect(rotated.current.id).not.toBe(first.id);
    expect(rotated.current.sdkSessionId).toBeNull();
    expect((await host.storage.get(first.id))?.archived).toBe(true);
    expect((await host.storage.get(target.id))?.archived).not.toBe(true);
    expect(host.channelBindings.store.get(identity)).toBeNull();
    expect((await host.invoke('local-db:messages:list', [first.id, { limit: 10 }]) as Array<{content:string}>).some(row => row.content === 'original channel task')).toBe(true);
    expect(pushes.some(event => event.channel === 'local-db:sessions:created' && (event.payload as {sessionId:string}).sessionId === rotated.current.id)).toBe(true);
    await host.close();
    const restarted = create(); await restarted.ready;
    const resumedRepo = restarted.channelRepository(config, namespace);
    expect((await resumedRepo.peekSession('bot', 'owner'))?.id).toBe(rotated.current.id);
    await expect(repo.findActiveSession('bot', 'owner')).rejects.toThrow('TASK_HOST_CLOSED');
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
  // without eagerly requiring its not-yet-created incarnation. Real SQLite,
  // native MCP transport and restart recovery use the integration time budget.
  it('starts and sends a task with the full plugin market composition installed',async()=>{
    const {host,root,vault,native}=await setup();
    const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid'}),membership:()=>null,token:()=>null,refresh:async()=>{},assertCurrent:()=>{}});
    const plugins=new TerminalPlugins({root,runtimeDirectory:root,executablePath:'unused',account,models:{models:host.models,utility:host.utility},assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},receive:async()=>({}),
      secrets:{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);},getSync:key=>vault.get(key)??null,setSync:(key,value)=>{vault.set(key,value);},deleteSync:key=>{vault.delete(key);},setManySync:entries=>{for(const [key,value] of Object.entries(entries))if(value===null)vault.delete(key);else vault.set(key,value);}},
      cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false,reason:'cancelled'}),writeSaveDeposit:async()=>null},
    });
    const market=new TerminalPluginMarket({root,host:plugins,account,assertCurrent:()=>{}});
    const createCompanion=()=>new TerminalCompanionHost({root:path.join(root,'companions'),profileDir:root,models:host.models,logger,guard:()=>{},emit:()=>{},binary:async()=>process.execPath,createAgent:native.create});
    let companions=createCompanion();
    const tasks=new TerminalPluginTasks({root,runtimeDirectory:root,host:plugins,account,market,tasks:host,companions:()=>companions,projectDirectories:async()=>[root],protectedInput:{configurePlugins:()=>{}},deposits:new DirDepositVault(),saves:new SaveDepositVault(),owner:()=>({mode:'local',dataOwnerId:'test',generation:1}),signedIn:()=>false,remoteAvailable:()=>false,locale:()=> 'en',assertCurrent:()=>{},emit:()=>{}});
    try{
      await plugins.ready;await tasks.ready;tasks.connectCompanions();await companions.modelSettings.saveDefaults([{...(await host.models.select()).selection,fastMode:false}]);
      // Integration tier: task ownership, durable replay, terminal input source
      // and cancellation were previously unavailable behind the plugin pipe.
      const installed = {dir:path.join(root,'_root__fixture-plugin'),enabled:true,approval:{state:'approved',revision:'00000000-0000-4000-8000-000000000001'},taskCapabilityApproved:true,
        instanceKey:'_root__fixture-plugin',namespace:null,manifest:{id:'fixture-plugin',name:'Task fixture',version:'1.0.0',mainView:{html:'main.html'},agent:{tasks:true,hiddenTasks:true}}} as unknown as import('@cindy/plugin-runtime/shared/ghost').InstalledGhost;
      const lookup=vi.spyOn(plugins.native,'list').mockReturnValue([installed]);
      const call=async(kind:string,args:Record<string,unknown>={})=>{
        const result=await plugins.receive('_root__fixture-plugin',{type:'tasks-request',kind,...args}) as {ok:boolean;data:any;error?:{code:string;message?:string}};
        if(!result.ok)throw new Error(`${result.error?.code}: ${result.error?.message}`);return result.data;
      };
      let created=await call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true});
      expect(await call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true})).toMatchObject({taskId:created.taskId,hidden:true});
      expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(false);
      {
      // Integration/security: targets used to fall through the real sandbox
      // pipe. Exercise owner-task and Profile delivery, independent approval,
      // receipt replay, revocation and cancellation through that same entry.
      const target=(kind:string,args:Record<string,unknown>={})=>plugins.receive('_root__fixture-plugin',{type:'targets-request',kind,...args}) as Promise<{ok:boolean;data:any;error?:{code:string}}>;
      expect(await target('list',{targetKind:'task'})).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
      installed.manifest.agent!.targets=true;installed.targetCapabilityApproved=true;
      const existing=await host.invoke('maker:create-session',[{title:'Owner target'}]) as {id:string};
      expect((await target('list',{targetKind:'task'})).data.targets.map((row:{id:string})=>row.id)).toContain(existing.id);
      expect((await target('list',{targetKind:'task'})).data.targets.map((row:{id:string})=>row.id)).not.toContain(created.taskId);
      const request={target:{kind:'task',id:existing.id},requestKey:'target-once',text:'Target queue'};
      const delivered=await target('send',request);expect(delivered).toMatchObject({ok:true,data:{taskId:existing.id,delivery:'queue'}});
      await expect.poll(()=>host.storage.queued(existing.id),{interval:5}).toEqual([]);
      await expect.poll(async()=>((await host.invoke('local-db:messages:list',[existing.id])) as Array<{role:string}>).some(row=>row.role==='assistant'),{interval:5}).toBe(true);
      expect(await target('send',request)).toEqual(delivered);expect(native.sentFor(existing.id)).toHaveLength(1);
      expect(await host.invoke('local-db:sessions:get',[existing.id])).not.toHaveProperty('source','plugin');
      expect(await host.invoke('local-db:messages:list',[existing.id])).toContainEqual(expect.objectContaining({role:'user',agentMeta:expect.objectContaining({sourcePlugin:{pluginId:'_root__fixture-plugin',name:'Task fixture'},autoReviewUserText:{kind:'delegated-continuation'}})}));
      await host.invoke('maker:send',[existing.id,{text:'wait-for-steer'}]);await native.waitForHeld(existing.id);
      expect(await target('send',{target:request.target,requestKey:'target-steer',text:'Target steer',delivery:'steer'})).toMatchObject({ok:true,data:{delivery:'steer'}});
      const cancelled=await target('send',{target:request.target,requestKey:'target-cancel',text:'Must not execute'});expect(cancelled.ok).toBe(true);
      expect(await target('cancel',{requestKey:'target-cancel'})).toMatchObject({ok:true});
      await target('send',{target:request.target,requestKey:'target-revoke',text:'Revoked queue'});
      delete installed.targetCapabilityApproved;native.finishHeld(existing.id);
      await expect.poll(()=>host.storage.queued(existing.id),{interval:5}).toEqual([]);
      expect(native.sentFor(existing.id)).toHaveLength(2);installed.targetCapabilityApproved=true;
      const project=await target('send',{target:{kind:'project',id:root},requestKey:'project-target',text:'Project target',title:'Project target'});
      expect(project.ok).toBe(true);expect(await host.storage.get(project.data.taskId)).toMatchObject({workDir:await realpath(root)});
      const profile=await companions.create({name:'Target companion'});
      expect((await target('list',{targetKind:'bot'})).data.targets).toContainEqual(expect.objectContaining({id:profile.id}));
      const companionRequest={target:{kind:'bot',id:profile.id},requestKey:'companion-target',text:'Companion queue'};
      expect(await target('send',companionRequest)).toMatchObject({ok:true,data:{taskId:profile.sessionId}});
      await expect.poll(async()=>(await companions.messages(profile.sessionId)).some(row=>row.role==='assistant'),{interval:5}).toBe(true);
      expect(await target('send',companionRequest)).toMatchObject({ok:true});expect(native.sentFor(profile.sessionId)).toHaveLength(1);
      expect((await companions.messages(profile.sessionId))[0].agentMeta).toMatchObject({sourcePlugin:{pluginId:'_root__fixture-plugin',name:'Task fixture'}});
      // A real companion runtime mounts the shared plugin gateway. File
      // consent must reach the same owner RPC, and abort must retire its card.
      const companionRuntime=native.inputs.findLast(input=>input.taskId===profile.sessionId)!;
      const gateway=companionRuntime.tools!.providers.find(provider=>provider.name==='cindy_ghosts');
      expect(gateway).toBeDefined();
      const pluginClient=new McpClient({name:'companion-plugins',version:'1'});
      const pluginServer=await gateway!.toClaudeSdkConfig!({sessionId:profile.sessionId,workingDir:path.join(companions.profiles.home(profile.id),'workspace'),agentKind:'claude-code'}) as {instance:McpServer};
      const [pluginLeft,pluginRight]=InMemoryTransport.createLinkedPair();await pluginServer.instance.connect(pluginLeft);await pluginClient.connect(pluginRight);
      try {
        expect((await pluginClient.listTools()).tools.some(tool=>tool.name==='ghost_info')).toBe(true);
        const info=await pluginClient.callTool({name:'ghost_list',arguments:{}});
        expect(info.isError).not.toBe(true);
      } finally { await pluginClient.close(); }
      const snapshot=await companions.pluginPermissionSnapshot(profile.sessionId);
      expect(snapshot?.isCurrent?.()).toBe(true);
      for (const behavior of ['deny','allow'] as const) {
        const decision=companions.requestPluginWrite(profile.sessionId,{ghostId:'_root__fixture-plugin',ghostName:'Task fixture',lane:'save_dir',operation:'write',items:[{name:'outside',absPath:root,size:0,isDirectory:true}]});
        const pending=await companions.invoke('maker:get-pending-interactions',[profile.sessionId],{source:'remote',deviceId:'owner-controller'}) as Array<{request:{requestId:string;toolName:string}}>;
        expect(pending).toHaveLength(1);expect(pending[0].request.toolName).toBe('cindy.plugin.write');
        companions.resolveInteraction(pending[0].request.requestId,{kind:'permission',behavior},{source:'remote',deviceId:'owner-controller'});
        expect((await decision).confirmed).toBe(behavior==='allow');
      }
      const abort=new AbortController();
      const cancelledPermission=companions.requestPluginWrite(profile.sessionId,{ghostId:'_root__fixture-plugin',ghostName:'Task fixture',lane:'save_dir',items:[{name:'outside',absPath:root,size:0,isDirectory:true}]},abort.signal);
      abort.abort();expect((await cancelledPermission).confirmed).toBe(false);
      expect(await companions.invoke('maker:get-pending-interactions',[profile.sessionId],{source:'local'})).toEqual([]);
      await companions.send(profile.id,'wait-for-steer','companion-held');await native.waitForHeld(profile.sessionId);
      expect(await target('send',{target:companionRequest.target,requestKey:'companion-steer',text:'Companion steer',delivery:'steer'})).toMatchObject({ok:true,data:{delivery:'steer'}});
      await target('send',{target:companionRequest.target,requestKey:'companion-cancel',text:'Cancelled companion'});
      await target('cancel',{requestKey:'companion-cancel'});
      await target('send',{target:companionRequest.target,requestKey:'companion-revoke',text:'Revoked companion'});
      delete installed.targetCapabilityApproved;native.finishHeld(profile.sessionId);
      await expect.poll(()=>companions.hasRunningWork(),{interval:5}).toBe(false);
      expect(native.sentFor(profile.sessionId)).toHaveLength(2);installed.targetCapabilityApproved=true;
      await companions.send(profile.id,'wait-for-steer','companion-uncertain-held');await native.waitForHeld(profile.sessionId);
      native.steer.reply=async()=>{throw new Error('fixture ACK lost');};
      const uncertainRequest={target:companionRequest.target,requestKey:'companion-uncertain',text:'Uncertain companion',delivery:'steer'};
      expect(await target('send',uncertainRequest)).toMatchObject({ok:false,error:{code:'DELIVERY_UNCERTAIN'}});
      expect(await companions.projection(profile.sessionId)).toMatchObject({queuePaused:true});
      expect(await target('send',uncertainRequest)).toMatchObject({ok:false,error:{code:'DELIVERY_UNCERTAIN'}});
      await companions.close();expect(snapshot?.isCurrent?.()).toBe(false);companions=createCompanion();await companions.ready;tasks.connectCompanions();
      native.steer.reply=async()=>{};
      await companions.resumePending();
      expect(await companions.projection(profile.sessionId)).toMatchObject({queuePaused:true,pendingQueue:[expect.objectContaining({text:'Uncertain companion'})]});
      expect(native.sentFor(profile.sessionId)).toHaveLength(3);
      // The restored durable input must check current approval at the native
      // boundary, even though its original process-local guard no longer exists.
      delete installed.targetCapabilityApproved;
      await companions.invoke('maker:input:resume',[profile.sessionId],{source:'local'});
      await expect.poll(()=>companions.hasRunningWork(),{interval:5}).toBe(false);
      expect(native.sentFor(profile.sessionId)).toHaveLength(3);
      expect((await companions.storage.latestSubmission(profile.sessionId))?.status).toBe('failed');
      installed.targetCapabilityApproved=true;
      }
      // Owner-facing resource entry remains usable after disabling the plugin.
      const registry=new RemoteResourceRegistry();registerPluginResources(registry,plugins,tasks.pages,tasks.sessions);
      const owner={controllerDeviceId:'terminal-owner'},client={protocolVersion:1,primitives:['text','actions'],locale:'en'};
      const get=vi.spyOn(plugins,'get').mockResolvedValue(installed);
      try{
        const detail=await registry.get(owner,{client,ref:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'}});
        const target=detail.links.find(link=>link.rel==='background-tasks')!.target;
        expect(target.kind).toBe('resource');if(target.kind!=='resource')throw new Error('Expected task list');
        installed.enabled=false;
        const background=await registry.get(owner,{client,ref:target.ref});
        expect(background.links).toEqual(expect.arrayContaining([expect.objectContaining({target:{kind:'session',sessionId:created.taskId}})]));
        const controller:TerminalClient={invoke:(async(channel:string,args:unknown[]=[],device?:string)=>{
          expect(device).toBe('plugin-server');const request=args[0] as never;
          // These child pages are deliberately absent from the root list.
          if(channel.endsWith(':list'))throw new Error('CHILD_IS_NOT_A_COLLECTION_ITEM');
          return channel.endsWith(':manifest')?registry.manifest(owner,request):channel.endsWith(':get')?registry.get(owner,request):registry.invoke(owner,request);
        }) as TerminalClient['invoke'],subscribe:()=>()=>{},close(){}};
        expect(await runResourceCommand(controller,{collection:'plugins',operation:'get',id:target.ref.id,device:'plugin-server',locale:'en'})).toMatchObject({ref:target.ref});
        await runResourceCommand(controller,{collection:'plugins',operation:'reveal-background',id:target.ref.id,input:{taskId:created.taskId},device:'plugin-server',locale:'en'});
        expect(await tasks.sessions.background('_root__fixture-plugin')).toEqual([]);
        expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(true);
      }finally{installed.enabled=true;get.mockRestore();}
      await call('setHidden',{taskId:created.taskId,hidden:true});
      expect((await call('models')).models).toEqual(expect.arrayContaining([expect.objectContaining({route:expect.objectContaining({model:'test-model'})})]));
      const provider=host.models.snapshot().providers.find(p=>p.id==='fixture')!;
      await host.models.saveProvider({...provider,runtimes:{'claude-code':{...provider.runtimes['claude-code']!,models:[...provider.runtimes['claude-code']!.models,{id:'test-second',name:'Second',contextWindow:200000,efforts:['medium','high'],supportsFastMode:true}]},pi:{baseUrl:'http://127.0.0.1:1',wireProtocol:'openai-chat',models:[{id:'test-pi',name:'Pi fixture',contextWindow:200000}]}}},{pi:'invalid-test-key-only'});
      // Owner settings must expose task routes even for a task-only plugin,
      // and persist the chosen engine/model without changing existing tasks.
      const preferences=await registry.get(owner,{client,ref:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'}});
      const modelField=preferences.actions?.find(action=>action.id==='model')?.fields?.find(field=>field.id==='model');
      if(modelField?.kind!=='select')throw new Error('TASK_MODEL_PICKER_MISSING');
      const second=modelField.options?.find(option=>String(option.label).includes('Second'));
      expect(second).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:second!.value}});
      const tuning=await registry.get(owner,{client,ref:preferences.ref});
      const tuningValues=(tuning.blocks?.find(block=>block.id==='task-tuning')?.data as {values:Record<string,unknown>}|undefined)?.values;
      expect(tuningValues).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'task-tuning',input:{...tuningValues,effort:'high',fastMode:'true'}});
      const usingPreference=await call('create',{title:'Plugin default model',requestKey:'configured-model'});
      expect(usingPreference.resolvedConfig).toMatchObject({agentKind:'cc',providerId:'fixture',model:'test-second',effort:'high',fastMode:true});
      expect((await call('get',{taskId:created.taskId})).resolvedConfig.model).toBe('test-model');
      const pi=modelField.options?.find(option=>String(option.label).includes('Pi fixture'));
      expect(pi).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:pi!.value}});
      const piTask=await call('create',{title:'Plugin Pi model',requestKey:'configured-pi-model'});
      expect(piTask.resolvedConfig).toMatchObject({agentKind:'pi',providerId:'fixture',model:'test-pi'});
      const piRun=await call('send',{taskId:piTask.taskId,requestKey:'pi-send',expectedRevision:piTask.revision,text:'plugin-pi-input'});
      await vi.waitFor(async()=>expect(await call('getRun',{runId:piRun.runId})).toMatchObject({status:'completed'}));
      expect(native.inputs.at(-1)?.selection.agentKind).toBe('pi');
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:''}});
      // Released GUI/Mobile actions must reach the same preferences as TUI.
      const request={client,collectionId:'plugins',resourceRef:preferences.ref};
      const remotePrefs=await registry.invoke(owner,{...request,actionId:'task-settings:get'});
      const before=remotePrefs.result as import('@cindy/device-link').PluginTaskPreferences;
      const saved=await registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:before.revision,model:{agentKind:'cc',providerId:'fixture',model:'test-second',fastMode:false}}});
      expect((saved.result as typeof before).config.model).toBe('test-second');
      await expect(registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:before.revision,permissionMode:'auto'}})).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
      const updated=saved.result as typeof before;
      await registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:updated.revision,model:null}});
      // Current GUI management is a separate released action family. Exercise
      // the real resource dispatcher, durable preferences and stale-page CAS.
      const managementOwner={controllerDeviceId:'local'};
      const manage=async(action:string,input:Record<string,unknown>={})=>(await registry.invoke(managementOwner,{...request,actionId:`management:${action}`,input})).result;
      const snapshot=await manage('snapshot') as import('@cindy/plugin-runtime/shared/pluginManagement').PluginManagementSnapshot;
      expect(snapshot).toMatchObject({hostPreferences:true,settingsPage:true,projectBrowse:true});
      expect(snapshot.ghosts[0]?.instanceKey).toBe(installed.instanceKey);
      const approval='approved:00000000-0000-4000-8000-000000000001';
      const guiBefore=await manage('preferences',{expectedInstalledApproval:approval}) as import('@cindy/plugin-runtime/shared/pluginPreferences').RemotePluginPreferenceSnapshot;
      expect(guiBefore.sidebarVisible).toBe(true);
      const guiSaved=await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiBefore.revision,kind:'tasks',patch:{model:{agentKind:'cc',providerId:'fixture',model:'test-second',effort:'high',fastMode:false}}}) as typeof guiBefore;
      expect(guiSaved.tasks?.config).toMatchObject({model:'test-second',effort:'high'});
      await expect(manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiBefore.revision,kind:'sidebar',visible:false})).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
      const guiHidden=await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiSaved.revision,kind:'sidebar',visible:false}) as typeof guiBefore;
      await tasks.preferences.refresh();expect(tasks.preferences.sidebarVisible(installed.instanceKey!)).toBe(false);
      await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiHidden.revision,kind:'tasks',patch:{model:null}});
      const project=await manage('project-select',{path:root}) as {id:string};
      const projectBefore=await manage('project-state',{projectId:project.id}) as {revision:string};
      await manage('begin',{operationId:'project-disable',kind:'disable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectBefore.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-disable'})).toMatchObject({phase:'succeeded'}));
      await tasks.preferences.refresh();expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(true);
      await manage('begin',{operationId:'project-stale',kind:'enable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectBefore.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-stale'})).toMatchObject({phase:'failed'}));
      expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(true);
      const projectAfter=await manage('project-state',{projectId:project.id}) as {revision:string};
      await manage('begin',{operationId:'project-enable',kind:'enable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectAfter.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-enable'})).toMatchObject({phase:'succeeded'}));
      expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(false);
      const previous=created;
      created=(await call('setModel',{taskId:created.taskId,expectedRevision:created.revision,route:{...created.resolvedConfig,model:'test-second'}})).task;
      expect(created.resolvedConfig.model).toBe('test-second');
      await expect(call('setModel',{taskId:created.taskId,expectedRevision:previous.revision,route:'plugin-default'})).rejects.toThrow('STALE_REVISION');
      created=(await call('setModel',{taskId:created.taskId,expectedRevision:created.revision,route:'plugin-default'})).task;
      expect(created.resolvedConfig.model).toBe('test-model');
      // The real pending-interaction path supplies owner consent. Refusing once
      // must not let a plugin reopen it; only the local owner's retry can do so.
      const confirm=async(id:string,behavior:'allow'|'deny')=>{
        const request=await vi.waitFor(async()=>{
          const pending=await host.invoke('maker:get-pending-interactions',[id]) as Array<{request:{requestId:string;toolName?:string}}>;
          expect(pending).toHaveLength(1);expect(pending[0].request.toolName).toBe('cindy.plugin.task.writeAccess');return pending[0].request;
        });
        await host.invoke('maker:resolve-interaction',[request.requestId,{kind:'permission',behavior}]);
      };
      const denied=call('requestWriteAccess',{taskId:created.taskId});
      await confirm(created.taskId,'deny');expect(await denied).toEqual({granted:false});
      expect(await call('requestWriteAccess',{taskId:created.taskId})).toEqual({granted:false});
      expect(await host.invoke('maker:get-pending-interactions',[created.taskId])).toEqual([]);
      expect(await host.invoke('maker:get-plugin-write-access-recovery',[created.taskId])).toEqual({granted:false,available:true});
      await expect(host.invoke('maker:retry-plugin-write-access',[created.taskId],{source:'remote',deviceId:'other'})).rejects.toThrow('LOCAL_ONLY_COMMAND');
      const granted=host.invoke('maker:retry-plugin-write-access',[created.taskId]);
      await confirm(created.taskId,'allow');expect(await granted).toMatchObject({granted:true,available:false,mode:'acceptEdits'});
      created=await call('get',{taskId:created.taskId});
      expect(created.permissionMode).toBe('acceptEdits');expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('acceptEdits');
      const run=await call('send',{taskId:created.taskId,requestKey:'send-1',expectedRevision:created.revision,text:'plugin-owned-input'});
      await vi.waitFor(async()=>expect(await call('getRun',{runId:run.runId})).toMatchObject({status:'completed'}));
      const firstPage=await call('readMessages',{taskId:created.taskId,limit:1});expect(firstPage.items[0]).toMatchObject({role:'user',content:'plugin-owned-input'});
      const secondPage=await call('readMessages',{taskId:created.taskId,limit:1,after:firstPage.nextCursor});expect(secondPage.items[0].role).toBe('assistant');
      const sent=native.sent.length;
      expect(await call('send',{taskId:created.taskId,requestKey:'send-1',expectedRevision:created.revision,text:'plugin-owned-input'})).toMatchObject({runId:run.runId,status:'completed'});
      expect(native.sent).toHaveLength(sent);
      expect(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]).toBe('');
      const history=await host.invoke('local-db:messages:list',[created.taskId,{limit:20}]) as Array<{role:string;agentMeta?:any}>;
      expect(history.find(row=>row.role==='user')?.agentMeta).toMatchObject({sourcePlugin:{pluginId:'_root__fixture-plugin'},autoReviewUserText:{kind:'delegated-continuation'}});
      await host.invoke('maker:set-permission-mode',[created.taskId,'ask']);
      await expect(call('requestWriteAccess',{taskId:created.taskId})).rejects.toThrow('TASK_BUSY');
      created=await call('get',{taskId:created.taskId});
      await host.invoke('maker:input:stop',[created.taskId]);
      const cancelled=await call('send',{taskId:created.taskId,requestKey:'queued-1',expectedRevision:created.revision,text:'never-dispatched'});
      expect(await call('cancel',{runId:cancelled.runId,requestKey:'cancel-1'})).toMatchObject({status:'cancelled'});
      expect(native.sent).toHaveLength(sent);
      const changing=await call('create',{title:'Changing permission',requestKey:'permission-race'});
      const stale=call('requestWriteAccess',{taskId:changing.taskId,mode:'auto'}).then(value=>value,error=>error);
      await vi.waitFor(async()=>expect(await host.invoke('maker:get-pending-interactions',[changing.taskId])).toHaveLength(1));
      await host.invoke('maker:set-permission-mode',[changing.taskId,'ask']);
      await confirm(changing.taskId,'allow');
      expect(await stale).toMatchObject({message:expect.stringContaining('TASK_BUSY')});
      expect((await host.storage.get(changing.taskId))?.permissionMode).toBe('ask');
      const rollback=await call('create',{title:'Failed preference commit',requestKey:'permission-rollback'});
      await host.invoke('maker:input:stop',[rollback.taskId]);
      const persist=vi.spyOn(plugins.models!,'setPermission').mockRejectedValueOnce(new Error('PREFERENCE_DISK_FAILURE'));
      const failed=call('requestWriteAccess',{taskId:rollback.taskId,mode:'auto'}).then(value=>value,error=>error);
      await confirm(rollback.taskId,'allow');expect(await failed).toBeInstanceOf(Error);persist.mockRestore();
      expect((await host.storage.get(rollback.taskId))?.permissionMode).toBe('acceptEdits');
      expect(native.permissionModes.slice(-2)).toEqual(['auto','acceptEdits']);
      expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('acceptEdits');
      expect(await host.invoke('maker:input:get-projection',[rollback.taskId])).toMatchObject({queuePaused:true});
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'},actionId:'task-permission',input:{permissionMode:'ask'}});
      expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('ask');
      await expect(call('send',{taskId:rollback.taskId,expectedRevision:rollback.revision,requestKey:'after-owner-revocation',text:'must not dispatch'})).rejects.toThrow('PERMISSION_DENIED');
      await expect(plugins.setTaskPermission('_root__fixture-plugin','bypassPermissions')).rejects.toThrow('INVALID_PERMISSION_MODE');
      // Integration: the native plugin pipe must persist an immutable plan only
      // before work starts, and a plan cannot grant a new directory.
      const planned=await call('create',{title:'Registered team plan',requestKey:'team-plan'});
      const plan={concurrency:1,items:[{label:'review',workingDir:planned.workingDir,route:planned.resolvedConfig,task:'Inspect the selected directory'}]};
      await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,items:[{...plan.items[0],workingDir:path.dirname(planned.workingDir)}]}})).rejects.toThrow('PERMISSION_DENIED');
      expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
      expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
      await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,concurrency:2}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await expect(call('setTeamPlan',{taskId:created.taskId,plan:{...plan,items:[{...plan.items[0],workingDir:created.workingDir}]}})).rejects.toThrow('TASK_BUSY');
      // Integration: plugin team commands share real Worker admission, final
      // completion receipts and Auto-review scope. The previous plan-only test
      // did not create/release a Worker or exercise revoked delegation.
      await expect(call('startTeam',{taskId:planned.taskId})).rejects.toThrow('PERMISSION_DENIED');
      const teamGrant=call('requestWriteAccess',{taskId:planned.taskId,mode:'auto'});
      await confirm(planned.taskId,'allow');expect(await teamGrant).toMatchObject({granted:true});
      await host.invoke('maker:input:stop',[planned.taskId]);
      expect(await call('startTeam',{taskId:planned.taskId})).toMatchObject({ok:true});
      expect(await call('getTeam',{taskId:planned.taskId})).toMatchObject({worker_count:0,capacity:{hardLimit:1,remainingSlots:1}});
      const workerArgs={leadSessionId:planned.taskId,role:'developer',label:'review',agent:planned.resolvedConfig.agentKind==='cc'?'claude-code' as const:planned.resolvedConfig.agentKind,
        model:planned.resolvedConfig.model,providerId:planned.resolvedConfig.providerId,effort:planned.resolvedConfig.effort||undefined,fast:planned.resolvedConfig.fastMode,workingDir:planned.workingDir};
      await expect(host.orcaLifecycle.createWorker({...workerArgs,label:'unplanned'})).rejects.toThrow('Worker is not pending');
      const workerResult=await host.orcaLifecycle.createWorker({...workerArgs,initialTask:'Inspect the selected directory'});
      if(!workerResult.ok)throw new Error(workerResult.message);
      const workerId=workerResult.workerId,workerSessionId=workerResult.workerSessionId;
      expect((await host.storage.get(workerSessionId))?.permissionMode).toBe('auto');
      const completedTeam=await vi.waitFor(async()=>{
        const team=await call('getTeam',{taskId:planned.taskId});
        expect(team.workers[0]?.completedAt).toEqual(expect.any(Number));return team;
      });
      expect(completedTeam.capacity).toMatchObject({hardLimit:1,occupiedSlots:1,remainingSlots:0});
      const reviewRequest:import('@cindy/maker-core').AutoReviewRequest={sessionId:workerSessionId,agentKind:workerArgs.agent,model:workerArgs.model,
        userIntent:'',workspaceRoots:[planned.workingDir],platform:process.platform,action:{kind:'exec',command:'pwd',cwd:planned.workingDir}};
      expect(await tasks.sessions.review(reviewRequest)).toMatchObject({delegatedTask:{role:'worker',task:plan.items[0].task}});
      await expect(call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt+1})).rejects.toThrow('STALE_REVISION');
      await plugins.setTaskPermission('_root__fixture-plugin','ask');
      const revokedReview=await tasks.sessions.review(reviewRequest);
      expect(revokedReview.authorizationError).toContain('no longer active');
      expect(revokedReview.delegatedTask).toBeUndefined();
      await plugins.setTaskPermission('_root__fixture-plugin','auto');
      expect(await call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt})).toMatchObject({ok:true,workerId});
      expect(await call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt})).toMatchObject({ok:true,workerId});
      expect((await host.storage.get(workerSessionId))?.archived).toBe(true);
      expect(await call('getTeam',{taskId:planned.taskId})).toMatchObject({worker_count:0,capacity:{remainingSlots:1}});
      await expect(host.orcaLifecycle.createWorker(workerArgs)).rejects.toThrow('Worker is not pending');
      await tasks.sessions.close();
      const reopened=new TerminalPluginSessions({root,host:plugins,tasks:host,guard:()=>{}});plugins.configureTaskSessions(reopened);
      try{
        await reopened.ready;
        expect(await call('getRun',{runId:run.runId})).toMatchObject({status:'completed'});
        expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
        await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,concurrency:2}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        await reopened.withUninstall('_root__fixture-plugin',async()=>{});
        expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(true);
        await expect(call('get',{taskId:created.taskId})).rejects.toThrow('TASK_NOT_FOUND');
        await expect(call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true})).rejects.toThrow('TASK_NOT_FOUND');
      }finally{await reopened.close();lookup.mockRestore();}
      const task=await host.invoke('maker:create-session',[{title:'Plugin composition'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'plugin-ready'}]);
      const normalHistory=await host.invoke('local-db:messages:list',[task.id,{limit:10}]) as Array<{content:string}>;
      expect(normalHistory.map(item=>item.content)).toContain('Echo: plugin-ready');
    }finally{await companions.close();await host.close();await tasks.close();await market.close();await plugins.close();account.close();}
  },30_000);
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

  // Behavior: a disk failure must not leave a more permissive live task behind
  // while GUI/IM settings still report the previous saved permission mode.
  it('rolls back the live permission when its durable update fails', async () => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{ permissionMode: 'ask' }]) as { id: string };
    const update = vi.spyOn(host.storage, 'update').mockRejectedValueOnce(new Error('fixture disk failure'));
    try { await expect(host.invoke('maker:set-permission-mode', [task.id, 'auto'])).rejects.toThrow('fixture disk failure'); }
    finally { update.mockRestore(); }
    expect(native.permissionModes).toEqual(['auto', 'ask']);
    expect((await host.storage.get(task.id))!.permissionMode).toBe('ask');
    expect(host.channelRuntime().getSession(task.id)!.stablePermissionModeState?.mode).toBe('ask');
    expect(await host.invoke('maker:set-permission-mode', [task.id, 'acceptEdits'])).toEqual({ success: true });
    expect((await host.storage.get(task.id))!.permissionMode).toBe('acceptEdits');
  });

  // Behavior: a GUI title request must use the terminal owner's configured
  // route without creating another task; settings changes invalidate late text.
  it('generates titles on the auxiliary route and rejects a stale model result', async () => {
    const { host, native } = await setup();
    const auxiliary=await auxiliaryFixture(host, () => native.title.reply());
    try {
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    expect(await host.invoke('maker:generate-title', [{ message: 'Configure my server', sessionId: task.id, agentKind: 'claude-code' }])).toEqual({ title: 'Server task' });
    expect(auxiliary.requests[0].model).toBe('test-utility');
    expect(native.starts).toHaveLength(1);
    expect(await host.storage.list()).toHaveLength(1);
    let entered!: () => void, finish!: (text: string) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    native.title.reply = () => { entered(); return new Promise<string>(resolve => { finish = resolve; }); };
    const pending = host.invoke('maker:generate-title', [{ message: 'A late reply', sessionId: task.id }]);
    await started;
    await host.invoke('terminal:models:reset-default');
    finish('Old model result');
    expect(await pending).toEqual({ title: null });
    } finally { await auxiliary.close(); }
  });

  // Behavior: attaching a channel after the native permission is already open
  // must retain one host decision, including cancellation of the old surface.
  it.each(['terminal', 'channel', 'close'] as const)('transfers an existing approval without duplicating its %s decision', async winner => {
    const { host, nextPush, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const running = host.invoke('maker:send', [task.id, { text: 'permission' }]);
    await requested;
    const [taken] = host.takeChannelInteractions(task.id);
    expect(taken.sharedPermission).toBeDefined();
    expect(host.takeChannelInteractions(task.id)).toEqual([]);
    expect(await host.invoke('maker:get-pending-interactions', [task.id])).toHaveLength(1);
    if (winner === 'terminal') await host.invoke('maker:resolve-interaction', [taken.requestId, { kind: 'permission', behavior: 'allow' }]);
    else if (winner === 'channel') taken.resolve({ kind: 'permission', behavior: 'allow' });
    else await host.invoke('maker:close-session', [task.id]);
    await running;
    expect(native.decisions).toHaveLength(1);
    expect(native.decisions[0]).toMatchObject({ kind: 'permission', behavior: winner === 'close' ? 'deny' : 'allow' });
    expect(await taken.sharedPermission!.result).toEqual(native.decisions[0]);
    expect(taken.sharedPermission!.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    expect(await host.invoke('maker:get-pending-interactions', [task.id])).toEqual([]);
  });

  // Behavior: the shared IM runner enriches a pre-persisted triggering message
  // after gathering group context. It must survive restart as one message and
  // cannot recreate a missing or cleared row, or touch another task's message.
  it('enriches the original channel message durably without copying its body', async () => {
    const { host, create } = await setup();
    const a = await host.invoke('maker:create-session', [{}]) as { id: string };
    const b = await host.invoke('maker:create-session', [{}]) as { id: string };
    const first = await host.persistChannelMessage({ sessionId: a.id, text: 'hello', source: { im: 'telegram', userText: 'hello' } });
    const source = { im: 'telegram', userText: 'hello', contextSnapshot: { groupContext: 'Relevant group context', groupMessageCount: 1 } };
    expect(await host.persistChannelMessage({ sessionId: a.id, text: 'must not replace', existingClientId: first!.clientId, source })).toEqual(first);
    expect(await host.persistChannelMessage({ sessionId: b.id, text: 'must not copy', existingClientId: first!.clientId, source })).toBeNull();
    await host.close();
    const restarted = create(); await restarted.ready;
    const rows = await restarted.invoke('local-db:messages:list', [a.id]) as Array<{ content: string; agentMeta: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'hello', agentMeta: { imSource: source } });
    expect(await restarted.invoke('local-db:messages:list', [b.id])).toEqual([]);
    await restarted.storage.update(a.id, { clearedAt: Date.now() });
    expect(await restarted.persistChannelMessage({ sessionId: a.id, text: 'must not recreate', existingClientId: first!.clientId, source })).toBeNull();
    expect(await restarted.invoke('local-db:messages:list', [a.id])).toEqual([]);
  });

  // Behavior: channel output must upload managed bytes, not expose server paths.
  // Reading outside the task is rejected by the shared source policy; generated
  // bytes retain tool provenance until the user actually attaches them.
  it('delivers task images from the media ledger with scope and origin intact', async () => {
    const { host, root, create } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string; workDir: string };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4sAAAAASUVORK5CYII=', 'base64');
    const image = path.join(task.workDir, 'output.png');
    const outside = path.join(root, 'outside.png');
    await writeFile(image, png); await writeFile(outside, png);
    const result = await host.materializeChannelImages({ sessionId: task.id, workingDir: task.workDir, text: `Done ![Result](${image})\n![Outside](${outside})` });
    expect(result.absPaths).toHaveLength(1);
    expect(result.absPaths[0]).toContain(`${path.sep}cindy-media${path.sep}blobs${path.sep}`);
    expect(await readFile(result.absPaths[0])).toEqual(png);
    expect(result.text).not.toContain(image);
    expect(result.text).not.toContain(outside);
    const url = `cindy-media://blobs/${path.basename(result.absPaths[0])}`;
    expect((await host.media.preparePluginAttachment(url, task.id, () => {})).originKind).toBe('tool');
    await host.persistChannelMessage({ sessionId: task.id, text: 'Use this', attachments: [{ kind: 'image', absPath: image, originalName: 'output.png', mimeType: 'image/png', url }] });
    expect((await host.media.preparePluginAttachment(url, task.id, () => {})).originKind).toBe('user');
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await realpath((await restarted.media.resolveManaged(url, task.id)).path)).toBe(result.absPaths[0]);
    await expect(restarted.media.resolveManaged(url, 'another-task')).rejects.toThrow('MEDIA_SESSION_ACCESS_DENIED');
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
    // Host authorization may carry a per-turn scope. A bridge that keeps only
    // `ok` silently drops that authority, including its revocation check.
    const helper = host.helperDeps.bind(host); let authorityActive = false, authorized = true;
    vi.spyOn(host, 'helperDeps').mockImplementation(input => {
      const deps = helper(input);
      return { ...deps, authorizeCall: async () => ({ ok: true, run: async operation => {
        if (!authorized) throw new Error('TURN_AUTHORITY_REVOKED');
        authorityActive = true; try { return await operation(); } finally { authorityActive = false; }
      } }), setCurrentSessionTitle: async value => {
        if (!authorityActive) throw new Error('HOST_AUTHORITY_CONTEXT_MISSING');
        return deps.setCurrentSessionTitle!(value);
      } };
    });
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
    const unbound = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Must not rename' } } } }) });
    expect(await unbound.text()).toContain('NO_SESSION_CONTEXT');
    tools.registerCodexMcpThreadContext({ threadId: 'real-thread', sessionId: task.id, sessionInstanceId: native.starts[0].sessionInstanceId, workingDir: native.starts[0].workingDir, vendorOptions: {}, mcpCallerKind: 'root', mcpCallerAttested: true });
    const call = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Renamed by actual MCP' } }, _meta: { threadId: 'real-thread' } } }) });
    const payload = await call.text();
    expect(payload).toContain('Renamed by actual MCP');
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({ title: 'Renamed by actual MCP' });
    authorized = false;
    const revoked = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Revoked rename' } }, _meta: { threadId: 'real-thread' } } }) });
    await revoked.text();
    expect(await host.storage.get(task.id)).toMatchObject({ title: 'Renamed by actual MCP' });
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
    let claudeProxy: Awaited<ReturnType<typeof createProviderProxy>> | undefined;
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
      // Claude's Messages protocol omits non-Anthropic effort. The host must
      // carry live preferences through both bridge layers into the Chat API.
      await host.invoke('maker:provider:custom:create', [{ id:'claudechat',name:'Claude Chat',runtimes:{'claude-code':{baseUrl:`http://127.0.0.1:${addr.port}`,wireProtocol:'openai-chat',models:[{id:'test-model',name:'Test',reasoning:true,reasoningEfforts:['low','high'],reasoningDefaultEffort:'high'}]}}},{'claude-code':'private-claude-key'}]);
      const claudeRoute=(await host.models.select({agentKind:'claude-code',providerId:'claudechat',model:'test-model'})).route;
      let effort='low';
      claudeProxy=await createProviderProxy(claudeRoute,'claude-code','private-claude-key',{},undefined,undefined,undefined,()=>({reasoningEffort:effort}));
      for(const selected of ['low','high']){
        effort=selected;
        const reply=await fetch(`${claudeProxy.url}/v1/messages`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${claudeProxy.token}`},body:JSON.stringify({model:'test-model',max_tokens:128,stream:false,messages:[{role:'user',content:'hello'}]})});
        expect(reply.status).toBe(200);await reply.text();
        expect(received.body?.reasoning_effort).toBe(selected);
        expect(received.headers?.authorization).toBe('Bearer private-claude-key');
      }
      expect(await host.invoke('maker:provider:test-connection',[{kind:'saved',providerId:'chatfixture',agent:'codex'}])).toMatchObject({ok:true});
      await host.invoke('maker:model-disable:set',[{kind:'model',providerId:'chatfixture',modelIds:['test-model'],disabled:true}]);
      await expect(host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).rejects.toThrow('MODEL_ROUTE_UNAVAILABLE');
      await host.invoke('maker:model-disable:set',[{kind:'reset',providerId:'chatfixture'}]);
      expect((await host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).selection.model).toBe('test-model');

    } finally { await proxy?.close(); await claudeProxy?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
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

  // Integration: configured notification resources must feed the real
  // scheduler completion, preserve the originating task and redact the URL.
  it('delivers scheduled results through Feishu and the configured WeCom group', async () => {
    const { host, root, vault } = await setup(), webhooks: string[] = [], notices: unknown[] = [];
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit: (channel, payload) => { if (channel === 'terminal:notification') notices.push(payload); }, secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } }, { wecomGroupFetch: async (_url, init) => { webhooks.push(String(init?.body)); return new Response('{"errcode":0}', { headers: { 'content-type': 'application/json' } }); } });
    const spies = [vi.spyOn(connections.feishu, 'getStatus').mockReturnValue({ kind: 'connected', appId: 'cli_schedule' }),
      vi.spyOn(connections.feishu, 'getOwnerOpenId').mockReturnValue('ou_owner'),
      vi.spyOn(connections.feishu, 'sendNotification').mockResolvedValue({ messageId: 'om_schedule', chatId: 'oc_owner' })];
    const configuration = new TerminalConfiguration(host.capabilities, undefined, { revision: () => connections.version(), save: (id, input) => connections.saveConfiguration(id, input) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, host, configuration);
    const ref = { collectionId: 'channels', kind: 'im-channel', id: 'wecom-group' }, context = { controllerDeviceId: 'terminal' }, client = { protocolVersion: 1, primitives: ['text', 'form', 'actions'], locale: 'en' };
    const scheduler = new TerminalSchedulerHost({ profileDir: root, tasks: host, logger, emit() {}, notify: (schedule, run) => connections.notify(schedule, run) }); schedulers.push(scheduler);
    try {
      await connections.start();
      const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-test-webhook-key';
      await configuration.save({ collectionId: 'channels', resourceId: ref.id, actionId: 'edit' }, { webhookUrl, testMessage: 'configured group test' }, { source: 'local' });
      const resource = await registry.get(context, { ref, client });
      expect(JSON.stringify(resource)).not.toContain(webhookUrl);
      expect(resource.actions?.find(action => action.id === 'edit')?.fields?.[0].kind).toBe('secret');
      expect(webhooks).toHaveLength(1);
      const scheduled = await scheduler.invoke('maker:schedule:create', [{ name: 'Channel completion', prompt: 'scheduled notification fixture', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: true,
        agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', workspaceKind: 'dialogue', useWorktree: false, persistentSession: true, notify: { desktop: true, feishu: true, wecomGroup: true } }]) as { id: string };
      await scheduler.invoke('maker:schedule:run-now', [scheduled.id]);
      await vi.waitFor(() => expect(webhooks).toHaveLength(2));
      expect(webhooks[1]).toContain('scheduled notification fixture'); expect(notices).toHaveLength(1);
      expect(connections.feishu.sendNotification).toHaveBeenCalledWith('ou_owner', expect.stringContaining('scheduled notification fixture'));
      const [run] = await scheduler.invoke('maker:schedule:list-runs', [scheduled.id]) as Array<{ sessionId: string }>;
      expect(await connections.notifications.resolveFeishuNotificationReply(connections.feishu, { senderId: 'ou_owner', contextId: 'cli_schedule', chatId: 'oc_owner', replyThread: { rootMessageId: 'om_schedule', threadId: 'omt_schedule' } } as IMMessageEvent)).toBe(run.sessionId);
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef: ref, actionId: 'enabled', input: { enabled: false } });
      expect(connections.wecomGroup.getState().enabled).toBe(false);
      await expect(connections.wecomGroup.publishMarkdown('disabled notification')).rejects.toThrow('WECOM_GROUP_NOTIFICATIONS_DISABLED');
      expect(webhooks).toHaveLength(2);
    } finally { await scheduler.close(); await connections.close(); configuration.close(); for (const spy of spies) spy.mockRestore(); }
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
      // A companion uses the real shared MCP source, but keeps its own choice,
      // memory scope and next-turn runtime. It must honor the account switch.
      const knowledge = new TerminalKnowledge({ root, logger, assertCurrent() {}, changed() {}, workingDirs: async () => [root] });
      await knowledge.configure({ memory: false });
      const companion = new TerminalCompanionHost({ root: path.join(root, 'companions'), profileDir: root, models: host.models,
        capabilities: host.capabilities, knowledge, logger, guard() {}, emit() {}, binary: async () => process.execPath, createAgent: native.create });
      const peer = new McpClient({ name: 'companion-fixture', version: '1' });
      const helper = new McpClient({ name: 'companion-control', version: '1' });
      try {
        await companion.modelSettings.saveDefaults([{...(await host.models.select()).selection,fastMode:false}]);
        const profile = await companion.create({ name: 'MCP companion' });
        await (await companion.send(profile.id, 'hello', 'first')).completion;
        const runtime = native.inputs.at(-1)!, start = native.starts.at(-1)!;
        expect(runtime.memory?.isEnabled()).toBe(false);
        expect(start.botRuntimeProfile?.mcpPolicy.catalog).toContainEqual({ name: 'fixture_mcp', source: 'custom', available: true });
        const ctx = { sessionId: profile.sessionId, workingDir: start.workingDir, agentKind: 'claude-code' as const,
          getSessionContext: () => ({ sessionId: profile.sessionId, workingDir: start.workingDir, agentKind: 'claude-code' as const }) };
        const connect = async (name: string, client: McpClient) => {
          const server = runtime.tools!.providers.find(provider => provider.name === name)!.toClaudeSdkConfig!(ctx) as { instance: McpServer };
          const [left, right] = InMemoryTransport.createLinkedPair(); await server.instance.connect(left); await client.connect(right);
        };
        await connect('fixture_mcp', peer);
        expect(await peer.callTool({ name: 'echo', arguments: { text: 'companion' } })).toMatchObject({ content: [{ type: 'text', text: 'upstream:companion' }] });
        await connect('cindy_helper', helper);
        const control=async(name:string,args:Record<string,unknown>={})=>{
          const response=await helper.callTool({name:'call_tool',arguments:{name,args}});
          const payload=response.isError?null:JSON.parse((response.content as Array<{text:string}>)[0].text);
          return {response,payload};
        };
        const before=await control('get_teammate_state');
        expect(before.payload.state).toMatchObject({profile:{id:profile.id,name:'MCP companion',version:1},memory:{enabled:false,scope:'self'}});
        const available=await control('get_app_default_model');
        const model=available.payload.available.find((choice:any)=>choice.route.providerId==='fixture'&&choice.route.harness==='claude');
        expect(model).toBeDefined();
        const edit={expectedVersion:1,name:'Personal companion',identitySource:'Independent personality',modelChain:[{id:model.id,fastMode:false}]};
        expect((await control('update_teammate_profile',edit)).payload).toMatchObject({ok:true,effective:'next-turn'});
        expect(await companion.profiles.read(profile.id,'SOUL.md')).toBe('Independent personality');
        expect((await control('update_teammate_profile',edit)).response.isError).toBe(true);
        expect((await control('set_app_default_model',{id:model.id})).payload).toMatchObject({ok:true,effective:'new-tasks'});
        expect((await companion.modelSettings.defaults())[0].providerId).toBe('fixture');
        const selected = await helper.callTool({ name: 'call_tool', arguments: { name: 'set_teammate_capability', args: { kind: 'mcp', id: 'fixture_mcp', joined: false } } });
        expect(selected.isError).not.toBe(true);
        expect((await companion.profiles.get(profile.id))?.capabilities).toMatchObject({ mcpMode: 'allowlist', mcpServers: [] });
        await (await companion.send(profile.id, 'next turn', 'second')).completion;
        expect(native.inputs.at(-1)!.tools!.providers.map(provider => provider.name)).not.toContain('fixture_mcp');
        expect(native.starts.at(-1)?.botProfilePrompt).toContain('Independent personality');
        expect((await host.invoke('maker:mcp:custom:list', []))).toMatchObject({ servers: [expect.objectContaining({ id: 'fixture_mcp', enabled: true })] });
        await knowledge.configure({ memory: true });
        await (await companion.send(profile.id, 'memory enabled', 'third')).completion;
        expect(native.inputs.at(-1)!.memory?.isEnabled()).toBe(true);
        expect(native.starts.at(-1)?.resumeSessionId).toBe(start.resumeSessionId ?? `native-${profile.sessionId}`);
      } finally { await helper.close(); await peer.close(); await companion.close(); await knowledge.close(); }
      await host.invoke('terminal:mcp:set-enabled',['fixture_mcp',false]);
      await expect(client.listTools()).rejects.toThrow();
      const other=await host.capabilities.runtime({workingDir:path.dirname(root),agentKind:'claude-code'});
      expect(other.factories).toEqual({});expect(await other.getManagedSkills()).toEqual([]);await other.close();
    }finally{await client.close();upstream.closeAllConnections();await Promise.all(peers.map(peer=>peer.close()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
  });

});
