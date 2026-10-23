import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Maker, type AgentEvent, type AgentKind, type BaseAgent, type InteractionDecision, type InteractionRequest, type Logger, type PermissionMode, type Session, type UserMessage } from '@cindy/maker-core';
import { buildClientDeviceNote, buildMessageSourceNote, messageSourceSenderFromMeta } from '@cindy/maker-shared/message-source';
import { resolveRoute, type Catalog, type ResolvedRoute } from '@cindy/model-providers';
import { type InvocationContext, type TerminalSecrets } from '../contracts.js';
import { createDeviceAgentStarter, readDeviceProviderViews, hostedStartOptions, type HostedStartInput, type DeviceAgentServiceDeps } from '@cindy/remote-agent';
import { createRemoteHistory } from './remote-history.js';
import { privateDirectory } from '../platform.js';
import { ENGINES, TerminalModelConfig, type ModelSelection } from '../models/config.js';
import { createTerminalAgent, discoverNativeModels, findAgentBinary, nativeAuthState, type RuntimeInput } from '../models/runtime.js';
import { createTaskTools } from './mcp.js';
import { TerminalTaskStorage, type TerminalTaskMeta, type Submission } from './storage.js';

export const TERMINAL_TASK_CHANNELS = [
  'local-db:history:messages', 'local-db:history:query', 'maker:input:enqueue', 'maker:input:get-projection', 'maker:create-session', 'maker:close-session', 'maker:abort-session', 'maker:send', 'maker:steer',
  'maker:list-active', 'maker:any-session-in-turn', 'maker:session-in-turn', 'maker:get-context-usage',
  'maker:get-pending-interactions', 'maker:resolve-interaction', 'maker:set-model', 'maker:set-effort',
  'maker:set-permission-mode', 'maker:set-plan-mode', 'maker:set-fast-mode', 'maker:compact-session',
  'maker:list-available-agents', 'maker:agent:status', 'maker:provider:list',
  'maker:provider:custom:create', 'maker:provider:custom:update', 'maker:provider:custom:delete',
  'terminal:tasks:turn-status', 'terminal:tasks:submit', 'terminal:tasks:status', 'terminal:tasks:wait',
  'terminal:tasks:list', 'terminal:tasks:get', 'terminal:tasks:history', 'terminal:tasks:delete', 'terminal:tasks:rename',
  'terminal:models:get', 'terminal:models:set-default', 'terminal:models:reset-default',
  'local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:update', 'local-db:sessions:patch-meta', 'local-db:messages:list',
] as const;

export interface TerminalTaskHostOptions {
  profileDir: string;
  logger: Logger;
  secretStore: TerminalSecrets;
  emit(channel: string, args: unknown[]): void;
  defaultTitle?: string | (() => string);
  authorizeGuestRequest?: (input: {sessionId:string;providerId:string;routeToken:string;model:string}) => Promise<boolean>;
  resolveExecutionRoute?: (input: { agentDeviceId?: string; providerId: string; model: string; agentKind: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding }, taskId: string) => Promise<{ agentDeviceId?: string; providerId: string; model: string; agentKind: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding }>;
  remoteInvoke?: DeviceAgentServiceDeps['remoteInvoke'];
  binaryPaths?: Partial<Record<AgentKind, string>>;
  catalog?: Catalog;
  /** Optional adapter injection for embedding and deterministic contract tests. */
  createAgent?: (input: RuntimeInput) => Promise<BaseAgent>;
  nativeStatus?: (kind: AgentKind, binary: string | null) => ReturnType<typeof nativeAuthState>;
}
type ScheduledOrigin = { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId: string };
type TaskInvocationContext = InvocationContext & { scheduler?: ScheduledOrigin };
type LiveTask = { maker: Maker; session: Session; selection: ModelSelection; dispose: Array<() => void | Promise<void>> };
type Pending = { sessionId: string; request: InteractionRequest; settle: (decision: InteractionDecision) => void };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_ARGUMENT'); return value; }
function permission(value: unknown): PermissionMode {
  if (!['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(String(value))) throw new Error('INVALID_PERMISSION_MODE');
  return value as PermissionMode;
}
function decisionForDismissal(request: InteractionRequest): InteractionDecision {
  return request.kind === 'ask_user_question' ? { kind: request.kind, answers: {}, dismissed: true }
    : { kind: request.kind, behavior: 'deny', reason: 'session_closed', ...(request.kind === 'plan_review' ? { dismissed: true } : {}) };
}

/** Persistent, UI-independent task service. Each live task delegates its loop,
 * cancellation and native transcript resume to the unchanged Maker adapters. */
export class TerminalTaskHost {
  readonly channels = TERMINAL_TASK_CHANNELS;
  readonly models: TerminalModelConfig;
  readonly storage: TerminalTaskStorage;
  private readonly live = new Map<string, LiveTask>();
  private readonly starts = new Map<string, Promise<LiveTask>>();
  private readonly pending = new Map<string, Pending>();
  private readonly queuedSubmissions = new Map<string, Array<{ requestId: string; message: UserMessage; context: TaskInvocationContext }>>();
  private readonly submissionText = new Map<string, string>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly receiptListeners = new Set<(receipt: Submission) => void>();
  private readonly sending = new Set<string>();
  private readonly groupBindings = new Map<string, import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding>();
  private readonly hosted = new Set<import('@cindy/maker-core').AgentSessionHandle>();
  private readonly binaries = new Map<AgentKind, string | null>();
  private readonly authCache = new Map<AgentKind, { at: number; value: Awaited<ReturnType<typeof nativeAuthState>> }>();
  private readonly ready: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly persistenceFaults = new Set<string>();

  constructor(private readonly options: TerminalTaskHostOptions) {
    if (!path.isAbsolute(options.profileDir)) throw new Error('PROFILE_DIRECTORY_MUST_BE_ABSOLUTE');
    this.storage = new TerminalTaskStorage(path.join(options.profileDir, 'tasks'));
    this.models = new TerminalModelConfig(options.profileDir, options.secretStore, kind => this.authState(kind), options.catalog, options.createAgent ? undefined : async kind => { const binary = this.binaries.get(kind); return binary ? discoverNativeModels(kind, binary, options.profileDir, options.logger) : []; });
    this.ready = this.initialize();
  }
  private async initialize() {
    await privateDirectory(this.options.profileDir);
    await Promise.all([this.storage.open(), this.models.open(), ...ENGINES.map(async kind => this.binaries.set(kind, await findAgentBinary(kind, this.options.binaryPaths?.[kind])))]);
    for (const row of await this.storage.list()) {
      if (row.groupBinding) this.groupBindings.set(row.id, row.groupBinding);
      const queued = await this.storage.queued(row.id);
      for (const receipt of queued) if (receipt.message) this.enqueueSubmission(row.id, receipt.message, receipt.requestId, { source: receipt.source ?? 'local', deviceId: receipt.deviceId, ownerId: receipt.ownerId, scheduler: receipt.scheduler, ...(receipt.sharedTask ? { sharedTask: receipt.sharedTask, assertCurrent: () => { throw new Error('SHARED_TASK_REVALIDATION_REQUIRED'); } } : {}) });
    }
  }
  private async authState(kind: AgentKind) {
    const cached = this.authCache.get(kind);
    if (cached && Date.now() - cached.at < 15_000) return cached.value;
    const value = await (this.options.nativeStatus ?? nativeAuthState)(kind, this.binaries.get(kind) ?? null);
    this.authCache.set(kind, { at: Date.now(), value });
    return value;
  }
  private emit(channel: string, payload: unknown) {
    if (this.closed) return;
    try { this.options.emit(channel, [payload]); }
    catch { this.options.logger.warn('Terminal subscriber delivery failed', { channel }); }
  }
  private view(row: TerminalTaskMeta) {
    const live = this.live.get(row.id);
    return { ...row, sessionId: row.id, status: live?.session.getStatus() ?? 'idle', isTurnRunning: live?.session.isTurnRunning() ?? false, pendingInteractions: [...this.pending.values()].filter(p => p.sessionId === row.id).map(p => p.request), ...(this.persistenceFaults.has(row.id) ? { persistenceError: true } : {}) };
  }
  private guiSession(row: TerminalTaskMeta) {
    return {
      ...this.view(row),
      userId: '', workingDir: row.workDir, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
      runtimeStatus: this.live.get(row.id)?.session.getStatus() ?? 'idle',
      agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind,
      sdkSessionId: row.sdkSessionId ?? null, providerId: row.providerId ?? null,
      planModeEnabled: row.planMode ?? false, fastMode: row.fastMode ?? false,
      pinnedAt: row.pinnedAt ? new Date(row.pinnedAt).toISOString() : null,
      parentSessionId: row.parentSessionId ?? null, remoteHostId: null, agentDeviceId: row.agentDeviceId ?? null,
      createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
      totalTokenUsage: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.tokenUsage ?? 0, totalCostUsd: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.costUsd ?? 0, contextTokens: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.contextTokens ?? 0, contextWindow: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.contextWindow ?? 0,
      extraDirs: [], writableDirs: [],
    };
  }
  listBindings() { return Object.fromEntries(this.groupBindings); }
  async sessionGroup(id: string) { const row = await this.storage.get(id); return row?.groupBinding ? { groupDeviceId: row.groupBinding.groupDeviceId ?? null, providerId: row.groupBinding.providerId } : null; }
  isTurnRunning(id: string): boolean { return this.starts.has(id) || this.sending.has(id) || this.activeSubmissions.has(id) || this.live.get(id)?.session.isTurnRunning() === true; }
  async submitScheduled(id: string, text: string, origin: Omit<ScheduledOrigin, 'kind'> & { requestId?: string; assertCurrent?: () => void }) {
    return this.submit(id, { text }, { requestId: origin.requestId ?? randomUUID() }, { source: 'local', assertCurrent: origin.assertCurrent, scheduler: { kind: 'scheduler', scheduleId: origin.scheduleId, scheduleName: origin.scheduleName, runId: origin.runId } });
  }
  isBusy(): boolean { return this.hosted.size > 0 || this.starts.size > 0 || this.sending.size > 0 || this.pending.size > 0 || [...this.queuedSubmissions.values()].some(queue => queue.length > 0) || [...this.live.values()].some(task => task.session.isTurnRunning()); }
  isAgentAvailable(kind: AgentKind): boolean { return Boolean(this.binaries.get(kind)); }
  async refreshBinaries(paths?: Partial<Record<AgentKind, string>>): Promise<void> {
    await Promise.all(ENGINES.map(async kind => this.binaries.set(kind, await findAgentBinary(kind, paths?.[kind] ?? this.options.binaryPaths?.[kind]))));
    this.authCache.clear();
  }
  async startHosted(input: HostedStartInput): Promise<import('@cindy/maker-core').AgentSessionHandle> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    // Sharing needs a per-run outbound credential boundary; never hand the local
    // native account or long-lived provider key to an isolated guest process.
    const chosen = await this.models.select({ agentKind: input.kind, providerId: input.options.providerId, model: input.options.model });
    if (input.guest && (chosen.route.provider.source !== 'user' || !input.guestProvider || !this.options.authorizeGuestRequest)) throw new Error('GUEST_PROVIDER_PROXY_REQUIRED');
    const authorizeRequest = input.guest && input.guestProvider ? (model: string) => this.options.authorizeGuestRequest!({sessionId:input.hostSessionId,providerId:chosen.selection.providerId,routeToken:input.guestProvider!.routeToken,model}) : undefined;
    if (authorizeRequest && !await authorizeRequest(chosen.selection.model)) throw new Error('GUEST_PROVIDER_UNAUTHORIZED');
    const binary = this.binaries.get(input.kind);
    if (!binary) throw new Error('ENGINE_NOT_INSTALLED');
    const agent = await (this.options.createAgent ?? createTerminalAgent)({ profileDir: this.options.profileDir, taskId: input.hostSessionId, selection: chosen.selection, route: chosen.route, binaryPath: binary, models: this.models, logger: this.options.logger, authorizeRequest });
    try {
      const handle = await agent.startSession(hostedStartOptions(input));
      const close = handle.close.bind(handle);
      handle.close = async () => { this.hosted.delete(handle); try { await close(); } finally { await agent.dispose(); } };
      if (this.closed) { await handle.close(); throw new Error('TASK_HOST_CLOSED'); }
      this.hosted.add(handle);
      return handle;
    } catch (error) { await agent.dispose(); throw error; }
  }
  private async selection(input: Record<string, unknown>) {
    if (input.agentDeviceId) {
      if (!this.options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
      const providers = await readDeviceProviderViews(this.options.remoteInvoke, string(input.agentDeviceId));
      const kinds = input.agentKind ? [input.agentKind as AgentKind] : [...ENGINES];
      for (const kind of kinds) {
        const provider = providers.find(p => p.connected && !p.suspended && (!input.providerId || p.id === input.providerId) && p.models[kind]?.some(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model)));
        const model = provider?.models[kind]?.find(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model));
        if (!provider || !model) continue;
        const route = resolveRoute(providers, provider.id, model.id, kind);
        if (route) return { selection: { agentKind: kind, providerId: provider.id, model: model.id, ...(input.effort ? { effort: input.effort as ModelSelection['effort'] } : {}) }, route };
      }
      throw new Error('REMOTE_MODEL_ROUTE_UNAVAILABLE');
    }
    if (input.model && input.providerId && input.agentKind) return this.models.select({ agentKind: input.agentKind, providerId: input.providerId, model: input.model, ...(input.effort ? { effort: input.effort } : {}) });
    if (input.agentKind || input.providerId || input.model) {
      const providers = await this.models.views();
      const kinds = input.agentKind ? [input.agentKind as AgentKind] : [...ENGINES];
      for (const kind of kinds) {
        const provider = providers.find(p => p.connected && (!input.providerId || p.id === input.providerId) && p.models[kind]?.some(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model)));
        const model = provider?.models[kind]?.find(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model));
        if (provider && model) return this.models.select({ agentKind: kind, providerId: provider.id, model: model.id, ...(input.effort ? { effort: input.effort } : {}) });
      }
      throw new Error('MODEL_ROUTE_UNAVAILABLE');
    }
    return this.models.select();
  }
  private async create(input: Record<string, unknown>, guard: () => void) {
    const id = randomUUID();
    if (this.options.resolveExecutionRoute && input.providerId && input.model && input.agentKind) input = { ...input, ...await this.options.resolveExecutionRoute(input as {agentKind:AgentKind;providerId:string;model:string},id) };
    const resolved = await this.selection(input);
    guard();
    const cwd = input.workingDir ?? input.workDir ?? path.join(this.options.profileDir, 'workspaces', id);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('WORKING_DIRECTORY_MUST_BE_ABSOLUTE');
    if (!input.workingDir && !input.workDir) await privateDirectory(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
    guard();
    await this.storage.create({ id, agentKind: resolved.selection.agentKind, model: resolved.selection.model, workDir: cwd, title: typeof input.title === 'string' ? input.title : typeof this.options.defaultTitle === 'function' ? this.options.defaultTitle() : this.options.defaultTitle ?? 'New task', permissionMode: input.permissionMode ? permission(input.permissionMode) : 'default', ...(typeof input.planMode === 'boolean' ? { planMode: input.planMode } : {}) });
    guard();
    await this.storage.setSelection(id, resolved.selection);
    if (input.agentDeviceId || input.groupBinding) await this.storage.update(id, { ...(input.agentDeviceId ? {agentDeviceId: string(input.agentDeviceId)} : {}), ...(input.groupBinding ? {groupBinding: input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding} : {}) });
    if(input.groupBinding)this.groupBindings.set(id,input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding);
    guard();
    await this.ensureLive(id, resolved);
    this.emit('terminal:tasks:changed', { sessionId: id });
    return this.view((await this.storage.get(id))!);
  }
  private ensureLive(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute }): Promise<LiveTask> {
    const existing = this.live.get(id);
    if (existing && existing.session.getStatus() === 'active') return Promise.resolve(existing);
    const starting = this.starts.get(id);
    if (starting) return starting;
    const result = this.start(id, resolved);
    this.starts.set(id, result);
    void result.finally(() => this.starts.delete(id)).catch(() => undefined);
    return result;
  }
  private async start(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute }): Promise<LiveTask> {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    const row = await this.storage.get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const previous = this.live.get(id);
    if (previous) await this.closeTask(id);
    if (!resolved && row.groupBinding && this.options.resolveExecutionRoute) { const execution=await this.options.resolveExecutionRoute({agentDeviceId:row.agentDeviceId,providerId:row.providerId!,model:row.model,agentKind:row.agentKind,groupBinding:row.groupBinding},id); resolved=await this.selection(execution); }
    const chosen = resolved ?? await this.selection({ agentDeviceId: row.agentDeviceId, agentKind: row.agentKind, providerId: row.providerId, model: row.model, ...(row.effort ? { effort: row.effort } : {}) });
    const binary = this.binaries.get(chosen.selection.agentKind);
    if (!binary && !row.agentDeviceId) throw new Error('ENGINE_NOT_INSTALLED');
    const tools = await createTaskTools({ sessionId: id, workingDir: row.workDir, agentKind: chosen.selection.agentKind,
      isCurrent: () => !this.closed,
      helper: {
        setCurrentSessionTitle: async ({ sessionId, title }) => { await this.patchMeta(sessionId, { title }); return { ok: true, sessionId, title }; },
        history: this.historyDeps(),
        runtimeCapabilities: async () => ({ terminal: true, tasks: true, nativeAgent: chosen.selection.agentKind, available: ['tasks', 'history', 'approvals', 'models'], unavailable: ['plugins', 'scheduler', 'contacts', 'browser', 'media-generation'] }),
      },
    });
    let agent;
    try { agent = await (this.options.createAgent ?? createTerminalAgent)({ profileDir: this.options.profileDir, taskId: id, selection: chosen.selection, route: chosen.route, binaryPath: binary ?? process.execPath, models: this.models, logger: this.options.logger, tools, remote: Boolean(row.agentDeviceId) }); } catch (error) { await tools.close(); throw error; }
    const startDeviceAgentSession = row.agentDeviceId && this.options.remoteInvoke ? createDeviceAgentStarter({ remoteInvoke: this.options.remoteInvoke, rgPath: () => 'rg', codexPath: () => this.binaries.get('codex') ?? undefined, mcpProviders: () => tools.providers, prepareMcpBridge: async () => tools.pi(), makerMemory: () => undefined, logger: this.options.logger }) : undefined;
    const maker = new Maker({ agents: { [chosen.selection.agentKind]: agent }, storage: this.storage, logger: this.options.logger, ...(startDeviceAgentSession ? { startDeviceAgentSession } : {}) });
    try {
      const session = await maker.createSession({ id, agentKind: chosen.selection.agentKind, workingDir: row.workDir, title: row.title, ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}), model: chosen.selection.model, providerId: chosen.selection.providerId, effort: chosen.selection.effort, permissionMode: row.permissionMode, planMode: row.planMode, ...(row.sdkSessionId ? { resumeSessionId: row.sdkSessionId } : {}) });
      const task: LiveTask = { maker, session, selection: chosen.selection, dispose: [() => tools.close()] };
      session.setInteractionListener((request, signal) => this.interaction(id, request, signal));
      task.dispose.push(session.onEvent(event => this.onEvent(id, event)));
      task.dispose.push(session.onStatusChange(status => this.emit('maker:status-changed', { sessionId: id, status })));
      this.live.set(id, task);
      if (this.closed) { await this.closeTask(id); throw new Error('TASK_HOST_CLOSED'); }
      return task;
    } catch (error) { await maker.shutdown(); await tools.close(); throw error; }
  }
  private onEvent(id: string, event: AgentEvent) {
    // Generated byte payloads are host-owned, not durable conversation text.
    let saved = event;
    if (event.type === 'image' && event.data && typeof event.data === 'object') {
      const { data: _bytes, ...data } = event.data as Record<string, unknown>;
      saved = { ...event, data };
    }
    void this.storage.append(id, { kind: 'event', event: saved }).then(row => {
      this.emit('maker:event', { sessionId: id, event: saved, sequence: row.sequence });
      const requestId = this.activeSubmissions.get(id);
      if (requestId && event.turnScope !== 'background' && event.type === 'text') {
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { text: String(event.data ?? '') };
        const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
        this.submissionText.set(id, data.isFinal === true ? text : (this.submissionText.get(id) ?? '') + text);
      }
      if (event.type === 'done') { setImmediate(() => this.drain(id)); const usage = this.live.get(id)?.session.getUsageSnapshot(); if (usage) void this.storage.update(id, { usage }).catch(() => this.persistenceFaults.add(id)); }
      if (requestId && event.turnScope !== 'background' && (event.type === 'done' || (event.type === 'error' && (event.data as { isTerminal?: boolean })?.isTerminal !== false))) {
        this.activeSubmissions.delete(id);
        void this.updateReceipt(id, requestId, event.type === 'done' ? 'completed' : 'failed', event.type === 'error' ? 'TURN_FAILED' : undefined, this.submissionText.get(id));
        this.submissionText.delete(id);
        setImmediate(() => this.drain(id));
      }
    }).catch(() => {
      this.persistenceFaults.add(id);
      this.emit('maker:event', { sessionId: id, event: { type: 'error', data: { reason: 'TASK_HISTORY_WRITE_FAILED', message: 'Unable to save task history', isTerminal: true } } });
      void this.live.get(id)?.session.abort().catch(() => undefined);
    });
  }
  private interaction(id: string, request: InteractionRequest, signal?: AbortSignal): Promise<InteractionDecision> {
    const publicRequest = { ...request, requestId: randomUUID() };
    return new Promise(resolve => {
      const settle = (decision: InteractionDecision) => {
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(publicRequest.requestId);
        this.emit('maker:interaction-dismissed', { sessionId: id, requestId: publicRequest.requestId });
        resolve(decision);
      };
      const cancel = () => settle(decisionForDismissal(publicRequest));
      this.pending.set(publicRequest.requestId, { sessionId: id, request: publicRequest, settle });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || this.closed) { cancel(); return; }
      this.emit('maker:interaction-request', { sessionId: id, request: publicRequest });
    });
  }
  private resolveInteraction(requestId: string, input: unknown) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('INTERACTION_NOT_PENDING');
    const raw = record(input);
    if (raw.kind !== pending.request.kind) throw new Error('INTERACTION_KIND_MISMATCH');
    let decision: InteractionDecision;
    if (raw.kind === 'ask_user_question') {
      const answers = record(raw.answers);
      if (Object.values(answers).some(value => typeof value !== 'string')) throw new Error('INVALID_ANSWERS');
      decision = { kind: 'ask_user_question', answers: answers as Record<string, string> };
    } else {
      if (raw.behavior !== 'allow' && raw.behavior !== 'deny') throw new Error('INVALID_PERMISSION_DECISION');
      decision = raw.kind === 'permission'
        ? { kind: 'permission', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}) }
        : { kind: 'plan_review', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(typeof raw.editedPlan === 'string' ? { editedPlan: raw.editedPlan } : {}) };
    }
    pending.settle(decision);
    return { success: true };
  }
  private async closeTask(id: string) {
    const task = this.live.get(id);
    if (!task) return;
    for (const pending of [...this.pending.values()]) if (pending.sessionId === id) pending.settle(decisionForDismissal(pending.request));
    const requestId = this.activeSubmissions.get(id);
    if (requestId) { this.activeSubmissions.delete(id); await this.updateReceipt(id, requestId, 'interrupted', 'SESSION_CLOSED', this.submissionText.get(id)); this.submissionText.delete(id); }
    await task.maker.shutdown();
    for (const dispose of task.dispose) await dispose();
    this.live.delete(id);
  }
  private guard(context: TaskInvocationContext) {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (context.signal?.aborted) throw new Error('REQUEST_ABORTED');
    context.assertCurrent?.();
  }
  async invoke(channel: string, args: unknown[] = [], context: TaskInvocationContext = { source: 'local' }): Promise<unknown> {
    this.guard(context);
    const result = await this.dispatch(channel, args, context);
    this.guard(context);
    return result;
  }
  private async dispatch(channel: string, args: unknown[], context: TaskInvocationContext): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (!Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
    this.guard(context);
    if (context.source === 'remote' && channel.startsWith('terminal:models:')) throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && (!context.ownerId || !context.deviceId || !context.assertCurrent)) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && args[1] && Object.keys(record(args[1])).length) throw new Error('PROTECTED_SECRET_SUBMISSION_REQUIRED');
    if (context.sharedTask) {
      const allowed = ['maker:input:enqueue', 'maker:input:get-projection', 'maker:send', 'maker:abort-session', 'maker:session-in-turn', 'maker:get-context-usage', 'maker:get-pending-interactions', 'maker:resolve-interaction', 'local-db:sessions:get', 'local-db:messages:list', 'local-db:history:messages', 'terminal:tasks:turn-status'];
      if (!allowed.includes(channel)) throw new Error('SHARED_TASK_PERMISSION_DENIED');
      const target = channel === 'maker:resolve-interaction' ? this.pending.get(string(args[0]))?.sessionId : channel === 'local-db:history:messages' ? record(args[0]).sessionId : args[0];
      if (target !== context.sharedTask.sessionId) throw new Error('SHARED_TASK_SCOPE_MISMATCH');
    }
    switch (channel) {
      case 'local-db:history:messages': return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context)).messages(args[0]);
      case 'local-db:history:query': {
        if (context.source !== 'remote' || context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context)).query(args[0]);
      }
      case 'maker:input:get-projection': return this.projection(string(args[0]));
      case 'maker:input:enqueue': {
        const id = string(args[0]); const item = record(args[1]);
        if (Array.isArray(item.files) && item.files.length || Array.isArray(item.sessionRefs) && item.sessionRefs.length || Array.isArray(item.mentions) && item.mentions.length) throw new Error('ATTACHMENT_INPUT_NOT_SUPPORTED');
        if (args[2] && record(args[2]).sendAtMs) throw new Error('SCHEDULED_INPUT_NOT_SUPPORTED');
        await this.submit(id, { text: string(item.text) }, { requestId: string(item.clientId) }, context);
        return this.projection(id);
      }
      case 'maker:create-session': return this.create(record(args[0] ?? {}), () => this.guard(context));
      case 'terminal:tasks:submit': return this.submit(string(args[0]), args[1], args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:turn-status': { const receipt = await this.storage.submission(string(args[0]), string(args[1])); if (!receipt) throw new Error('SUBMISSION_NOT_FOUND'); return this.receiptView(receipt); }
      case 'terminal:tasks:status': return this.storage.submission(string(args[0]), string(args[1]));
      case 'terminal:tasks:wait': return this.waitReceipt(string(args[0]), string(args[1]), args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:list': return (await this.storage.list()).map(row => this.view(row));
      case 'local-db:sessions:list': return (await this.storage.list()).filter(row => args[1] === 'archived' ? row.archived && !row.deleted : args[1] === 'deleted' ? row.deleted : !row.archived && !row.deleted).slice(0, typeof args[0] === 'number' ? Math.min(1000, Math.max(1, args[0])) : 100).map(row => this.guiSession(row));
      case 'local-db:sessions:get': { const row = await this.storage.get(string(args[0])); return row ? this.guiSession(row) : null; }
      case 'local-db:sessions:update': case 'local-db:sessions:patch-meta': return this.patchMeta(string(args[0]), record(args[1]));
      case 'local-db:messages:list': return this.messages(string(args[0]), args[1] === undefined ? {} : record(args[1]));
      case 'terminal:tasks:get': { const row = await this.storage.get(string(args[0])); if (!row) throw new Error('TASK_NOT_FOUND'); return this.view(row); }
      case 'terminal:tasks:history': { const page = args[1] === undefined ? {} : record(args[1]); return this.storage.history(string(args[0]), Number(page.after ?? 0), Number(page.limit ?? 200)); }
      case 'terminal:tasks:rename': { const row = await this.storage.update(string(args[0]), { title: string(args[1]) }); this.emit('terminal:tasks:changed', { sessionId: row.id }); return this.view(row); }
      case 'terminal:tasks:delete': { const id = string(args[0]); if (this.starts.has(id)) throw new Error('TASK_STARTING'); await this.closeTask(id); await this.storage.delete(id); this.emit('terminal:tasks:changed', { sessionId: id }); return { success: true }; }
      case 'maker:list-active': { const sessions = [...this.live.values()].map(({ session }) => ({ sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir, capabilities: session.capabilities, isTurnRunning: session.isTurnRunning() })); return args[0] && record(args[0]).snapshotVersion === 2 ? { format: 'active-sessions-v2', sessions } : sessions; }
      case 'maker:any-session-in-turn': return [...this.live.values()].some(task => task.session.isTurnRunning());
      case 'maker:session-in-turn': return this.live.get(string(args[0]))?.session.isTurnRunning() ?? false;
      case 'maker:get-pending-interactions': return [...this.pending.values()].filter(p => p.sessionId === args[0]).map(p => ({ request: p.request }));
      case 'maker:resolve-interaction': return this.resolveInteraction(string(args[0]), args[1]);
      case 'maker:close-session': { const id = string(args[0]); if (this.starts.has(id)) throw new Error('TASK_STARTING'); await this.closeTask(id); return { success: true }; }
      case 'maker:abort-session': { const task = this.live.get(string(args[0])); await task?.session.abort(); return { success: true }; }
      case 'maker:send': {
        if (args[1] && typeof args[1] === 'object' && typeof (args[1] as Record<string, unknown>).clientId === 'string') {
          const receipt = await this.submit(string(args[0]), args[1], { requestId: (args[1] as Record<string, unknown>).clientId }, context);
          return { accepted: !['failed', 'interrupted'].includes(receipt.status), requestId: receipt.requestId, clientId: receipt.requestId, status: receipt.status, ...(receipt.error ? { reason: receipt.error } : {}) };
        }
        const id = string(args[0]);
        if (this.persistenceFaults.has(id)) throw new Error('TASK_HISTORY_WRITE_FAILED');
        if (this.sending.has(id) || this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
        const message: UserMessage = typeof args[1] === 'string' ? { type: 'user', content: args[1] } : this.message(args[1]);
        this.sending.add(id);
        try {
          const task = await this.ensureLive(id);
          this.guard(context);
          const agentMeta = context.scheduler ? { origin: context.scheduler } : context.sharedTask ? { sharedTaskAuthor: { memberId: context.sharedTask.memberId, accountId: context.sharedTask.accountId, displayName: context.sharedTask.name ?? context.sharedTask.memberId } } : context.source === 'remote' && context.deviceId ? { sourceDevice: { deviceId: context.deviceId, platform: 'desktop' as const } } : undefined;
          await this.storage.append(id, { kind: 'user', message, clientId: this.activeSubmissions.get(id), origin: context.source, ...(agentMeta ? { agentMeta } : {}) });
          this.guard(context);
          const payload = context.scheduler ? { ...message, content: `${typeof message.content === 'string' ? message.content : ''}\n\n[Scheduled run context]\nschedule: ${JSON.stringify(context.scheduler.scheduleName)} (schedule_id: ${context.scheduler.scheduleId})\nrun_id: ${context.scheduler.runId}\nfiredAtUtc: ${new Date().toISOString()}` } : agentMeta ? { ...message, content: `${typeof message.content === 'string' ? message.content : ''}\n\n${'sourceDevice' in agentMeta && agentMeta.sourceDevice ? buildClientDeviceNote(agentMeta.sourceDevice) : buildMessageSourceNote(messageSourceSenderFromMeta(agentMeta))}` } : message;
          return await task.session.send(payload, ...(context.scheduler ? [{ origin: context.scheduler }] : []));
        } finally { this.sending.delete(id); }
      }
      case 'maker:steer': return (await this.ensureLive(string(args[0]))).session.steer(typeof args[1] === 'string' ? args[1] : this.message(args[1]));
      case 'maker:get-context-usage': return (await this.ensureLive(string(args[0]))).session.getContextUsage();
      case 'maker:set-model': {
        const id = string(args[0]); const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
        if (this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
        const opts = args[2] === undefined ? {} : record(args[2]);
        const chosen = await this.selection({ agentKind: row.agentKind, model: string(args[1]), providerId: opts.providerId ?? row.providerId, effort: opts.effort });
        await this.closeTask(id); await this.storage.setSelection(id, chosen.selection); await this.ensureLive(id, chosen); return { success: true };
      }
      case 'maker:set-effort': { const task = await this.ensureLive(string(args[0])); const selection = { ...task.selection, effort: args[1] }; const chosen = await this.models.select(selection); await task.session.setEffort(chosen.selection.effort!); task.selection = chosen.selection; await this.storage.setSelection(task.session.id, chosen.selection); return { success: true }; }
      case 'maker:set-permission-mode': { const task = await this.ensureLive(string(args[0])); const mode = permission(args[1]); await task.session.setPermissionMode(mode); await this.storage.update(task.session.id, { permissionMode: mode }); return { success: true }; }
      case 'maker:set-plan-mode': { if (typeof args[1] !== 'boolean') throw new Error('INVALID_ARGUMENT'); const task = await this.ensureLive(string(args[0])); await task.session.setPlanMode(args[1]); await this.storage.update(task.session.id, { planMode: args[1] }); return { success: true }; }
      case 'maker:set-fast-mode': { if (typeof args[1] !== 'boolean' && args[1] !== 'ultrafast') throw new Error('INVALID_ARGUMENT'); const task = await this.ensureLive(string(args[0])); await task.session.setFastMode(args[1]); await this.storage.update(task.session.id, { fastMode: args[1] }); return { success: true }; }
      case 'maker:compact-session': return (await this.ensureLive(string(args[0]))).session.compactSession(typeof args[1] === 'string' ? args[1] : undefined);
      case 'maker:list-available-agents': return ENGINES.filter(kind => Boolean(this.binaries.get(kind)));
      case 'maker:agent:status': { const kind = string(args[0]) as AgentKind; if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE'); const binary = this.binaries.get(kind) ?? null; const auth = await this.authState(kind); return { binaryReady: Boolean(binary), binaryPath: binary, authReady: auth.authenticated, ...auth }; }
      case 'maker:provider:list': return this.models.views();
      case 'terminal:models:get': return this.models.snapshot();
      case 'terminal:models:set-default': await this.models.setDefault(args[0], () => this.guard(context)); return this.models.snapshot();
      case 'terminal:models:reset-default': await this.models.resetDefault(() => this.guard(context)); return this.models.snapshot();
      case 'maker:provider:custom:create': case 'maker:provider:custom:update': await this.models.saveProvider(args[0], args[1] ?? {}, channel.endsWith(':create'), () => this.guard(context)); this.emit('maker:provider:changed', {}); return { success: true };
      case 'maker:provider:custom:delete': await this.models.deleteProvider(string(args[0]), () => this.guard(context)); this.emit('maker:provider:changed', {}); return { success: true };
      default: throw new Error(`UNSUPPORTED_CHANNEL:${channel}`);
    }
  }
  private async updateReceipt(id: string, requestId: string, status: Submission['status'], error?: string, finalText?: string) {
    try {
      const receipt = await this.storage.updateSubmission(id, requestId, status, error, finalText);
      this.emit('terminal:tasks:submission', receipt);
      for (const listener of this.receiptListeners) listener(receipt);
      return receipt;
    } catch { this.options.logger.error('Terminal submission persistence failed'); return null; }
  }
  private receiptView(receipt: Submission) {
    const pendingRequests = [...this.pending.values()].filter(item => item.sessionId === receipt.sessionId).map(item => item.request);
    return { ...receipt, clientId: receipt.requestId, status: pendingRequests.length && ['running', 'sending'].includes(receipt.status) ? 'waiting' : receipt.status === 'sending' ? 'running' : receipt.status, errorCode: receipt.error ?? null, finalText: receipt.finalText ?? this.submissionText.get(receipt.sessionId) ?? '', pendingRequests };
  }
  private async submit(id: string, input: unknown, options: Record<string, unknown>, context: TaskInvocationContext) {
    const message = typeof input === 'string' ? { type: 'user' as const, content: input } : this.message(input);
    const requestId = options.requestId === undefined ? randomUUID() : string(options.requestId);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('INVALID_REQUEST_ID');
    const fingerprint = createHash('sha256').update(JSON.stringify({ message, memberId: context.sharedTask?.memberId })).digest('hex');
    const claimed = await this.storage.claimSubmission(id, requestId, fingerprint, () => this.guard(context), { message, source: context.source, deviceId: context.deviceId, ownerId: context.ownerId, sharedTask: context.sharedTask, scheduler: context.scheduler });
    if (!claimed.created) return claimed.receipt;
    // Acceptance is durable before work begins; reconnecting with the same key
    // returns the original receipt, including after a process restart.
    this.enqueueSubmission(id, message, requestId, { ...context, signal: undefined });
    return claimed.receipt;
  }
  private enqueueSubmission(id: string, message: UserMessage, requestId: string, context: TaskInvocationContext) {
    const queue = this.queuedSubmissions.get(id) ?? [];
    if (!queue.some(item => item.requestId === requestId)) queue.push({ message, requestId, context });
    this.queuedSubmissions.set(id, queue);
    setImmediate(() => this.drain(id));
    void this.projection(id).then(projection => this.emit('maker:input:projection', projection)).catch(() => undefined);
  }
  private drain(id: string) {
    if (this.closed || this.activeSubmissions.has(id) || this.starts.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning()) return;
    const next = this.queuedSubmissions.get(id)?.shift();
    if (next) void this.runSubmission(id, next.message, next.requestId, next.context);
  }
  private async projection(id: string) {
    const row = await this.storage.get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const queued = await this.storage.queued(id);
    return { sessionId: id, turnInProgress: this.activeSubmissions.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning() === true,
      pendingQueue: queued.map(item => ({ clientId: item.requestId, text: item.message?.content ?? '', persistedContent: item.message?.content ?? '', model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'default', workingDir: row.workDir,
        chatMessage: { clientId: item.requestId, role: 'user', content: item.message?.content ?? '', createdAt: new Date(item.createdAt).toISOString() },
        createOpts: { agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId },
      })), steeringQueueClientIds: [], queuePaused: false, queueExpanded: true, queueInteractionLocks: [], queueEditLocks: [], queueAbortPending: false, error: null, errorReason: null, recovery: null, errorRetryText: null, credentialSwitchWait: null };
  }
  private async runSubmission(id: string, message: UserMessage, requestId: string, context: TaskInvocationContext) {
    try {
      this.guard(context);
      if (this.activeSubmissions.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
      this.activeSubmissions.set(id, requestId);
      if (!await this.updateReceipt(id, requestId, 'sending')) throw new Error('SUBMISSION_PERSISTENCE_FAILED');
      const result = await this.invoke('maker:send', [id, message], context) as { accepted: boolean; reason?: string };
      if (!result.accepted) throw new Error(result.reason ?? 'SEND_REJECTED');
      await this.updateReceipt(id, requestId, 'running');
      void this.projection(id).then(projection => this.emit('maker:input:projection', projection)).catch(() => undefined);
      setImmediate(() => this.drain(id));
    } catch (error) {
      if (this.activeSubmissions.get(id) === requestId) this.activeSubmissions.delete(id);
      const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SEND_FAILED';
      await this.updateReceipt(id, requestId, 'failed', reason);
      setImmediate(() => this.drain(id));
    }
  }
  private async waitReceipt(id: string, requestId: string, options: Record<string, unknown>, context: TaskInvocationContext) {
    const current = await this.storage.submission(id, requestId);
    if (!current) throw new Error('SUBMISSION_NOT_FOUND');
    if (['completed', 'failed', 'interrupted'].includes(current.status)) return current;
    const timeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30_000, options.timeoutMs)) : 25_000;
    return new Promise<Submission>((resolve, reject) => {
      const finish = (receipt: Submission) => { cleanup(); resolve(receipt); };
      const listener = (receipt: Submission) => { if (receipt.requestId === requestId && receipt.sessionId === id && ['completed', 'failed', 'interrupted'].includes(receipt.status)) finish(receipt); };
      const abort = () => { cleanup(); reject(new Error('REQUEST_ABORTED')); };
      const timer = setTimeout(() => { void this.storage.submission(id, requestId).then(receipt => { if (receipt) finish(receipt); else abort(); }); }, timeout);
      const cleanup = () => { clearTimeout(timer); this.receiptListeners.delete(listener); context.signal?.removeEventListener('abort', abort); };
      this.receiptListeners.add(listener);
      context.signal?.addEventListener('abort', abort, { once: true });
      // Subscribe first, then re-read to close the completion/read race.
      void this.storage.submission(id, requestId).then(receipt => { if (receipt) listener(receipt); }).catch(abort);
      if (context.signal?.aborted) abort();
    });
  }
  private message(value: unknown): UserMessage {
    const input = record(value);
    if (typeof input.text === 'string') return { type: 'user', content: input.text };
    if (input.type !== 'user' || typeof input.content !== 'string') throw new Error('TEXT_MESSAGE_REQUIRED');
    return { type: 'user', content: input.content };
  }
  private async messages(id: string, options: Record<string, unknown>, internal = false) {
    const limit = typeof options.limit === 'number' ? Math.max(1, Math.min(internal ? Infinity : 1000, options.limit)) : 200;
    const beforeSequence = options.before ? Number(string(options.before).split(':').at(-1)) : Infinity;
    const afterSequence = options.after ? Number(string(options.after).split(':').at(-1)) : -1;
    if (Number.isNaN(beforeSequence) || Number.isNaN(afterSequence)) throw new Error('INVALID_MESSAGE_CURSOR');
    const result: Array<{ id: string; clientId: string; sessionId: string; role: string; content: string; createdAt: string; agentKind: string | null; agentMeta: Record<string, unknown> | null }> = [];
    const add = (message: typeof result[number]) => {
      const sequence = Number(message.id.split(':').at(-1));
      if (sequence < beforeSequence && sequence > afterSequence && (!options.beforeTs || Date.parse(message.createdAt) < Number(options.beforeTs))) { result.push(message); if (result.length > limit) result.shift(); }
    };
    const task = await this.storage.get(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    let after = 0;
    let assistant: typeof result[number] | undefined;
    do {
      const page = await this.storage.history(id, after, 1000);
      for (const row of page.records) {
        if (row.kind === 'user' && row.message) {
          assistant = undefined;
          const content = typeof row.message.content === 'string' ? row.message.content : row.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          add({ id: `${id}:${row.sequence}`, clientId: row.clientId ?? `${id}:${row.sequence}`, sessionId: id, role: 'user', content, createdAt: new Date(row.timestamp).toISOString(), agentKind: task.agentKind === 'claude-code' ? 'cc' : task.agentKind, agentMeta: row.agentMeta ?? null });
        } else if (row.event?.type === 'text') {
          const data = typeof row.event.data === 'string' ? { text: row.event.data } : record(row.event.data);
          const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
          if (!assistant || row.event.standaloneText) {
            assistant = { id: `${id}:${row.sequence}`, clientId: `${id}:${row.sequence}`, sessionId: id, role: 'assistant', content: text, createdAt: new Date(row.timestamp).toISOString(), agentKind: task.agentKind === 'claude-code' ? 'cc' : task.agentKind, agentMeta: row.event.agentMeta ?? null };
            add(assistant);
          } else assistant.content = data.isFinal === true ? text : assistant.content + text;
          if (row.event.standaloneText) assistant = undefined;
        } else if (row.event && ['tool_use', 'tool_result', 'tool_result_full', 'thinking', 'error'].includes(row.event.type)) {
          assistant = undefined;
          const data = row.event.data && typeof row.event.data === 'object' ? row.event.data as Record<string, unknown> : { text: row.event.data };
          if (row.event.type !== 'thinking' || data.stage === 'final' || data.stage === 'redacted') add({ id: `${id}:${row.sequence}`, clientId: `${id}:${row.sequence}`, sessionId: id, role: row.event.type === 'tool_result_full' ? 'tool_result' : row.event.type, content: row.event.type === 'tool_use' ? JSON.stringify(data) : String(data.fullText ?? data.text ?? data.summary ?? data.message ?? ''), createdAt: new Date(row.timestamp).toISOString(), agentKind: task.agentKind === 'claude-code' ? 'cc' : task.agentKind, agentMeta: row.event.agentMeta ?? null });
        } else if (row.event?.type === 'done') assistant = undefined;
      }
      if (!page.hasMore) break;
      after = page.nextCursor;
    } while (true);
    return result.reverse();
  }
  private historyDeps(): import('../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js').XdtHelperHistoryDeps {
    type Cursor = { id: string; createdAt: number };
    const page = <T extends Cursor>(items: T[], limit: number, order: 'asc' | 'desc', cursor: Cursor | null) => {
      const direction = order === 'asc' ? 1 : -1;
      const sorted = items.sort((a, b) => direction * (a.createdAt - b.createdAt || a.id.localeCompare(b.id))).filter(item => !cursor || direction * (item.createdAt - cursor.createdAt || item.id.localeCompare(cursor.id)) > 0);
      const selected = sorted.slice(0, limit);
      const last = selected.at(-1);
      return { items: selected, hasMore: sorted.length > limit, nextCursor: sorted.length > limit && last ? { id: last.id, createdAt: last.createdAt } : null };
    };
    const sessions = async (scope: string[] | null) => (await this.storage.list()).filter(row => scope === null || scope.includes(row.id));
    const read = async (args: { sessionIds: string[] | null; workdir: string | null; fromMs: number | null; toMs: number | null; agentKind: string | null; roles: string[] | null }) => {
      const items: import('../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js').HistoryMessage[] = [];
      for (const task of await sessions(args.sessionIds)) {
        const agentKind = task.agentKind === 'claude-code' ? 'cc' : task.agentKind;
        if ((args.workdir && task.workDir !== args.workdir) || (args.agentKind && args.agentKind !== agentKind)) continue;
        for (const message of await this.messages(task.id, { limit: Infinity }, true)) {
          const createdAt = Date.parse(message.createdAt);
          if ((args.fromMs !== null && createdAt < args.fromMs) || (args.toMs !== null && createdAt > args.toMs) || (args.roles && !args.roles.includes(message.role))) continue;
          items.push({ ...message, createdAt, sessionWorkingDir: task.workDir, sessionAgentKind: agentKind, sessionTitle: task.title, toolUseId: null, rewindAt: null });
        }
      }
      return items;
    };
    return {
      listSessions: async args => ({ ok: true, page: page((await sessions(args.sessionIds)).filter(row => (args.includeDeleted || !row.deleted) && (!args.workdir || row.workDir === args.workdir) && (!args.agentKind || (row.agentKind === 'claude-code' ? 'cc' : row.agentKind) === args.agentKind) && (args.fromMs === null || row.createdAt >= args.fromMs) && (args.toMs === null || row.createdAt <= args.toMs)).map(row => ({ id: row.id, title: row.title, workingDir: row.workDir, agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind, workspaceKind: 'local', model: row.model, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', source: 'local', orcaRole: null, parentSessionId: row.parentSessionId ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt, userSendAt: null, messageCount: 0 })), args.limit, args.order, args.cursor) }),
      listWorkdirs: async args => {
        const dirs = new Map<string, { id: string; createdAt: number; workingDir: string; sessionCount: number; firstSessionAt: number; lastSessionAt: number; agentKinds: string[] }>();
        for (const row of await sessions(args.sessionIds)) {
          const item = dirs.get(row.workDir) ?? { id: row.workDir, createdAt: row.createdAt, workingDir: row.workDir, sessionCount: 0, firstSessionAt: row.createdAt, lastSessionAt: row.createdAt, agentKinds: [] };
          item.sessionCount++; item.firstSessionAt = Math.min(item.firstSessionAt, row.createdAt); item.lastSessionAt = Math.max(item.lastSessionAt, row.updatedAt); item.createdAt = item.lastSessionAt;
          if (!item.agentKinds.includes(row.agentKind)) item.agentKinds.push(row.agentKind);
          dirs.set(row.workDir, item);
        }
        return { ok: true, page: page([...dirs.values()], args.limit, args.order, args.cursor) };
      },
      getMessages: async args => ({ ok: true, page: page(await read(args), args.limit, args.order, args.cursor) }),
      searchChatHistory: async args => {
        const candidates = await read(args);
        const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = candidates.filter(message => terms.every(term => String(message.content).toLocaleLowerCase().includes(term))).sort((a, b) => b.createdAt - a.createdAt);
        const selected = matches.slice(args.offset, args.offset + args.limit);
        return { ok: true, result: { hits: selected.map((message, index) => ({ messageId: message.id, sessionId: message.sessionId, role: message.role, createdAt: message.createdAt, snippet: String(message.content).slice(0, 400), score: 1 / (60 + args.offset + index + 1), ftsRank: null, vectorRank: null, vectorDistance: null, context: [{ ...message, isHit: true }] })), sessions: Object.fromEntries(selected.map(message => [message.sessionId, { workingDir: message.sessionWorkingDir, agentKind: message.sessionAgentKind, title: message.sessionTitle }])), vectorUsed: false, vectorSkipReason: 'Terminal journal text matching; embeddings are not configured', nextOffset: args.offset + selected.length < matches.length ? args.offset + selected.length : null, hasMore: args.offset + selected.length < matches.length, poolSize: matches.length, poolCapped: false } };
      },
    };
  }
  private async patchMeta(id: string, patch: Record<string, unknown>) {
    if (Object.keys(patch).some(key => !['title', 'status', 'pinnedAt'].includes(key))) throw new Error('UNSUPPORTED_SESSION_PATCH_FIELD');
    const update: Partial<TerminalTaskMeta> = {};
    if (patch.title !== undefined) update.title = string(patch.title);
    if (patch.status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(String(patch.status))) throw new Error('INVALID_SESSION_STATUS');
      if (patch.status !== 'active' && (this.starts.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning())) throw new Error('SESSION_RUNNING');
      update.archived = patch.status === 'archived'; update.deleted = patch.status === 'deleted';
      if (patch.status !== 'active') await this.closeTask(id);
    }
    if (patch.pinnedAt !== undefined) {
      const at = patch.pinnedAt === null ? null : typeof patch.pinnedAt === 'number' ? patch.pinnedAt : Date.parse(string(patch.pinnedAt));
      if (at !== null && !Number.isFinite(at)) throw new Error('INVALID_PINNED_TIMESTAMP');
      update.pinnedAt = at;
    }
    const row = await this.storage.update(id, update);
    this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    return this.guiSession(row);
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    this.closed = true;
    await this.ready;
    await Promise.allSettled(this.starts.values());
    await Promise.all([...this.live.keys()].map(id => this.closeTask(id)));
    await Promise.allSettled([...this.hosted].map(handle => handle.close()));
    await Promise.all([this.storage.flush(), this.models.flush()]);
  }
}
