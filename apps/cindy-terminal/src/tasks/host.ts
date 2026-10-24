import { preparePersistedOrcaSessionStart } from '@cindy/orca-workflow/host/orcaSessionStartOptions';
import { createOrcaRemoteWorkers } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
import { createOrcaTeamService, type OrcaTeamService, type OrcaManualInterruptSnapshot } from '@cindy/orca-workflow/host/orcaTeamService';
import { createOrcaInterAgentDispatcher } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
import { toDesktopSessionDispatchOutcome } from '@cindy/im-runtime/sendOutcome';
import type { ControlSteerOutcome, QueuedSteerOutcome } from '@cindy/im-runtime/sessionQueueControl';
import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import { assertTerminalOrcaInput, captureTerminalOrcaInput, terminalOrcaHistoryMessage, type TerminalOrcaInput } from './orca-input.js';
import { TerminalOrcaReports } from './orca-reports.js';
import { TerminalOrcaQueue } from './orca-queue.js';
import { createTerminalOrcaLifecycle } from './orca-lifecycle.js';
import { createTerminalOrcaTools } from './orca-tools.js';
import { createTerminalOrcaIpc, ORCA_CONTROL_CHANNELS } from './orca-ipc.js';
import { createOrcaIdleReleaseWatcher } from '@cindy/orca-workflow/host/orcaIdleReleaseWatcher';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ORCA_EXECUTION_DEVICES_CHANNEL } from '@cindy/device-link';
import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import { createOrcaRemoteWorkerForwarder } from '@cindy/orca-workflow/host/orcaRemoteWorkerBridge';
import { TerminalOrcaStore } from './orca-store.js';
import { createOrcaRemoteWorkerMcpProvider, createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow/mcp';
import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import { createTerminalRemoteWorkerHost, REMOTE_WORKER_CHANNELS, readRemoteWorkerAssignment, assertRemoteWorkerAssignment, type RemoteWorkerAssignment } from './orca-remote.js';
import type { OrcaRemoteLead } from '@cindy/maker-shared/orca-remote-worker';
import { isSameSessionExecution } from '@cindy/plugin-runtime/sessionExecutionOwnership';
import type { TerminalPluginSessionPort, TerminalPluginSessionHooks } from '../plugins/session-contract.js';
import type { TerminalPluginTask } from '../plugins/mcp.js';
import type { PluginTaskContext } from '../plugins/permissions.js';
import type { TerminalPluginSetup } from '../plugins/setup.js';
import { parseGhostSetupInlineSubmitRequest } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
import { createGhostSetupInteractionSurface } from '@cindy/plugin-runtime/ghostSetupInteractionSurface';
import { createHash, randomUUID } from 'node:crypto';
import { stat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeCodeAgent, CodexAgent, PiAgent, Maker, type AgentEvent, type AgentKind, type BaseAgent, type InteractionDecision, type InteractionRequest, type Logger, type PermissionMode, type Session, type UserMessage } from '@cindy/maker-core';
import { buildClientDeviceNote, buildMessageSourceNote, messageSourceSenderFromMeta } from '@cindy/maker-shared/message-source';
import { resolveRoute, type Catalog, type ResolvedRoute } from '@cindy/model-providers';
import { type InvocationContext, type TerminalSecrets } from '../contracts.js';
import { createDeviceAgentStarter, readDeviceProviderViews, readRemoteProviderRoute, hostedStartOptions, type HostedStartInput, type DeviceAgentServiceDeps } from '@cindy/remote-agent';
import { readTaskDelivery, validateTaskDelivery, type TaskDeliveryProof } from './handoff.js';
import { TerminalTaskMedia } from './media.js';
import { persistedUserContentToWireMessage, isContextOverflowErrorData, isOversizedHistoryErrorData, isUnsupportedRequestOptionErrorData, type ContextOverflowRolloverDeps } from '@cindy/im-runtime/contextOverflowRollover';
import { createAutoReviewIntentProjection } from '@cindy/maker-shared/auto-review-intent';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, INHERITED_CAPABILITY_SELECTION, PI_CACHE_RECOVERY_EXPECTATION } from '@cindy/maker-core';
import type { AutoReviewDelegate, AutoReviewRequest } from '@cindy/maker-core';
import { normalizeTaskInput, appendInputText, inputPlainText, persistedInput, type InputHost, type AttachmentLifecycle } from './input.js';
import { createRemoteHistory } from './remote-history.js';
import { atomicPrivateWrite, readPrivateFile, privateDirectory } from '../platform.js';
import { testConnection, fetchModels } from '../models/operations.js';
import { ENGINES, TerminalModelConfig, type ModelSelection } from '../models/config.js';
import { createTerminalAgent, discoverNativeModels, findAgentBinary, nativeAuthState, type RuntimeInput } from '../models/runtime.js';
import { createTaskTools } from './mcp.js';
import type { TerminalKnowledge } from '../knowledge.js';
import { TerminalCapabilities, CAPABILITY_CHANNELS } from './capabilities.js';
import { registerCapabilityResources } from './capability-resources.js';
import { installDesktopInteractionHandler, beginInteractionRoute, requestHostInteraction, noteInteractionRouteSteer } from '@cindy/im-runtime/interactionRouter';
import { createSharedPermission, type SharedPermission } from '@cindy/im-runtime/sharedPermission';
import type { ImTurnHost } from '@cindy/im-runtime/turnHost';
import { createInboundFileStaging } from '@cindy/im-runtime/inboundFileStaging';
import { TerminalImBindings } from '../im/bindings.js';
import { TerminalImDefaults } from '../im/defaults.js';
import { TerminalImControl } from '../im/control.js';
import { TerminalImOrchestrators } from '../im/orchestrator.js';
import { buildImDefaultRouteRecord } from '@cindy/im-runtime/channelDefaultRoute';
import type { ImCommandHost } from '@cindy/im-runtime/commandHost';
import type { ImCardHost } from '@cindy/im-runtime/cardHost';
import { lookupPending, resolvePending } from '@cindy/im-runtime/pendingInteractions';
import { resolveLenientRoute } from '@cindy/model-providers/model-route-guard';
import { modelSupportsFastMode, sourcesForModel } from '@cindy/model-providers';
import { createTerminalChannelRouteFollower, type TerminalChannelRouteConfig } from '../im/routes.js';
import { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import { createTerminalImSessionRepo } from '../im/session-repo.js';
import type { ImOrchestratorConfig, ImSessionNamespace } from '@cindy/im-runtime/types';
import type { Capabilities, MakerEventListener } from '@cindy/maker-core';
import { createHistoryViewReader } from '@cindy/remote-agent/host/historyViewReader';
import type { HistoryWorkReference } from '@cindy/maker-shared/message-window';
import { TerminalTaskStorage, type TerminalTaskMeta, type Submission } from './storage.js';
import { TerminalUtilityModels } from '../models/utility.js';
import { registerUtilityModelResources } from '../models/utility-resources.js';
import type { UtilityNativeAgents } from '@cindy/model-providers/utility-model/host';
import { TerminalTaskChanges, TASK_CHANGE_CHANNELS } from './changes.js';
import { TerminalTurnLifecycle } from './turn-lifecycle.js';
import { createChannelTurnSignals } from '@cindy/im-runtime/channelTurnSignal';
import { createRuntimeRecoveryNotices } from '@cindy/im-runtime/runtimeRecoveryNotice';
import { createSessionPermissionChanges } from '@cindy/im-runtime/sessionPermissionChange';
import { PluginTaskError } from '@cindy/plugin-runtime/pluginTaskService';
import { changeSessionPermissionMode } from '@cindy/im-runtime/permissionModeControl';
import { buildAutoTitlePrompt } from '@cindy/im-runtime/titlePrompt';
import { validateTitleOutput } from '@cindy/im-runtime/titleOutputValidation';
import { fbotTitle } from '@cindy/im-runtime/title';
import { isCredentialModeSwitchBusyError } from '@cindy/im-runtime/credentialModeSwitchError';
import { TerminalTaskContext } from './context.js';
import { TerminalTaskRoutes } from './routes.js';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';
import type { Locale } from '../ui/i18n.js';
import { redactToolInputForUntrustedBoundary } from '@cindy/remote-agent/host/toolInputRedaction';

export const TERMINAL_TASK_CHANNELS = [
  'maker:auxiliary-model-settings:get', 'maker:auxiliary-model-settings:set',
  'maker:switch-session-agent', 'maker:get-session-agent-switch-intent',
  'maker:generate-title',
  ...CAPABILITY_CHANNELS,
  ...TASK_CHANGE_CHANNELS,
  'maker:plugin-setup:submit-inline',
  'local-db:messages:around','local-db:messages:around-client-id','local-db:messages:view','local-db:messages:view-intent','local-db:messages:work-details',
  'maker:input:stop', 'maker:input:resume', 'maker:input:remove', 'maker:input:update-text', 'maker:input:update-content', 'maker:input:move', 'maker:input:set-expanded', 'maker:input:set-edit-lock', 'maker:input:set-interaction-lock', 'maker:get-capabilities', 'maker:get-new-maker-defaults', 'maker:git-safety:get', 'maker:get-session-tree', 'maker:set-thinking-enabled', 'maker:session:handoff', 'local-db:history:messages', 'local-db:history:query', 'maker:input:enqueue', 'maker:input:get-projection', 'maker:create-session', 'maker:close-session', 'maker:abort-session', 'maker:send', 'maker:steer',
  'maker:list-active', 'maker:any-session-in-turn', 'maker:session-in-turn', 'maker:session:turn-active', 'maker:get-context-usage',
  'maker:get-pending-interactions', 'maker:resolve-interaction', 'maker:set-model', 'maker:set-effort',
  'maker:set-permission-mode', 'maker:set-plan-mode', 'maker:set-fast-mode', 'maker:compact-session',
  'maker:get-plugin-write-access-recovery', 'maker:retry-plugin-write-access',
  ...REMOTE_WORKER_CHANNELS,
  ...ORCA_CONTROL_CHANNELS,
  ORCA_EXECUTION_DEVICES_CHANNEL,
  'local-db:orca-workflows:get-by-lead', 'local-db:orca-workflows:get-by-worker-session',
  'local-db:orca-workflows:list-workers-by-lead', 'local-db:orca-workflows:list-workers-by-leads',
  'maker:list-available-agents', 'maker:agent:status', 'maker:provider:list',
  'maker:provider:presets', 'maker:provider:test-connection', 'maker:provider:models-fetch', 'maker:provider:models-refresh', 'maker:provider:models-rediscover', 'maker:provider:models-auto-refresh', 'maker:provider:custom:disconnect', 'maker:model-disable:set',
  'maker:provider:custom:create', 'maker:provider:custom:update', 'maker:provider:custom:delete',
  'terminal:tasks:turn-status', 'terminal:tasks:submit', 'terminal:tasks:status', 'terminal:tasks:wait',
  'terminal:tasks:list', 'terminal:tasks:get', 'terminal:tasks:history', 'terminal:tasks:delete', 'terminal:tasks:rename',
  'terminal:models:get', 'terminal:models:set-default', 'terminal:models:reset-default',
  'binding:resolve-session', 'binding:list-attached', 'binding:revoke',
  'local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:update', 'local-db:sessions:patch-meta', 'local-db:messages:list',
] as const;

export interface TerminalTaskHostOptions extends InputHost {
  profileDir: string;
  deviceId?: string;
  remoteWorkerLocations?: () => Promise<Array<{ agentDeviceId: string; name: string }>>;
  listOrcaDevices?: () => Promise<{ devices: import('@cindy/remote-agent/shared/deviceLinkIpc').DeviceLinkDeviceView[] }>;
  logger: Logger;
  secretStore: TerminalSecrets;
  emit(channel: string, args: unknown[]): void;
  deferPendingTasks?:boolean;
  defaultTitle?: string | (() => string);
  silentStopMessage?: () => string;
  runtimeRecoveryMessage?: () => string;
  language?: () => Locale;
  protectedInput?: import('../protected-input.js').TerminalProtectedInput;
  beforeTaskUnavailable?: (sessionId:string)=>Promise<void>;
  authorizeHostedRequest?: (input: {sessionId:string;providerId:string;model:string}) => Promise<boolean>;
  authorizeGuestRequest?: (input: {sessionId:string;providerId:string;routeToken:string;model:string}) => Promise<boolean>;
  resolveExecutionRoute?: (input: { agentDeviceId?: string; providerId?: string; model?: string; agentKind?: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding }, taskId: string) => Promise<{ agentDeviceId?: string; providerId: string; model: string; agentKind: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding } | null>;
  remoteInvoke?: DeviceAgentServiceDeps['remoteInvoke'];
  binaryPaths?: Partial<Record<AgentKind, string>>;
  catalog?: Catalog;
  region?: 'cn' | 'global';
  /** Optional adapter injection for embedding and deterministic contract tests. */
  createAgent?: (input: RuntimeInput) => Promise<BaseAgent>;
  nativeStatus?: (kind: AgentKind, binary: string | null) => ReturnType<typeof nativeAuthState>;
}
type ScheduledOrigin = { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId: string; firedAt?: number };
type TaskInvocationContext = InvocationContext & { targetPlugin?: { id: string; name: string }; collaboration?: TerminalOrcaInput; orca?: RemoteWorkerAssignment; scheduler?: ScheduledOrigin; sender?: {sessionId:string;title?:string}; plugin?: {id:string;name:string}; normalizedInput?: boolean; deliveryProof?: TaskDeliveryProof };
type LiveTask = { revoke():void; didInjectOrcaInstructions: boolean; plugin?:TerminalPluginTask; capabilityRevision: number; modelRevision: number; maker: Maker; session: Session; selection: ModelSelection; dispose: Array<() => void | Promise<void>> };
type Pending = { sessionId: string; sourceRequestId: string; request: InteractionRequest; settle: (decision: InteractionDecision) => void; decide: (decision:InteractionDecision)=>boolean; deferred?:InteractionDecision; shared?: SharedPermission; migrated?: boolean };

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
  private pluginTargetValidator?: (taskId: string, clientId: string) => Promise<void>;
  private async assertPluginTargetInput(id: string, clientId?: string) {
    if (!clientId || !this.pluginTargetValidator) throw new Error('PLUGIN_TARGET_AUTHORITY_UNAVAILABLE');
    await this.pluginTargetValidator(id, clientId);
  }
  /** Only the sandbox target slot registers this port. A target delivery never
   * makes an existing owner task into a plugin-owned task. */
  configurePluginTargetDelivery(validate: (taskId: string, clientId: string) => Promise<void>) {
    this.pluginTargetValidator = validate;
    return {
      send: async (plugin: { id: string; name: string }, id: string, clientId: string, text: string,
        images: import('@cindy/plugin-runtime/pluginMessageAttachments').PluginMessageImage[],
        guard: () => void, delivery: 'queue' | 'steer'): Promise<'queue' | 'steer'> => {
        const current = async () => { this.guard({ source: 'local' }); guard(); await validate(id, clientId); guard(); };
        await current();
        const files: NonNullable<AgentInputQueuedMessage['files']> = [];
        for (const image of images) {
          const media = await this.media.ingest({ sessionId: id, bytes: image.buffer, mimeType: image.mimeType, name: image.name }, guard);
          await current(); files.push({ id: image.hash, category: 'image', path: media.path, mimeType: image.mimeType, name: image.name, ext: path.extname(image.name), size: image.buffer.length });
        }
        if (delivery === 'steer') {
          const outcome = await this.routes.withLock(id, async () => {
            await current();
            const session = this.live.get(id)?.session, row = await this.storage.get(id);
            if (!session?.isTurnRunning() || !row) return 'not-attempted';
            const item: AgentInputQueuedMessage = { clientId, text, persistedContent: text, model: row.model,
              effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'default', workingDir: row.workDir, files,
              sourcePlugin: { pluginId: plugin.id, name: plugin.name },
              chatMessage: { clientId, role: 'user', content: text, createdAt: new Date().toISOString() },
              createOpts: { agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId } };
            return this.steerOrcaInput(id, item, { session, turnGeneration: session.getTurnGeneration() }, plugin);
          });
          if (outcome === 'steered') return 'steer';
          if (outcome === 'queued') throw new Error('DELIVERY_UNCERTAIN');
          if (outcome === 'rejected') throw new Error('DELIVERY_REJECTED');
        }
        await current();
        // A turn may end between reserving a steering input and its native
        // boundary. That input already owns its normalized queue receipt.
        const existing = await this.storage.submission(id, clientId);
        if (existing) {
          if (existing.targetPlugin?.id !== plugin.id || existing.status !== 'queued' || existing.error === 'STEER_DELIVERY_UNCERTAIN')
            throw new Error('DELIVERY_UNCERTAIN');
          return 'queue';
        }
        const receipt = await this.submit(id, { text, files }, { requestId: clientId }, { source: 'local', targetPlugin: plugin, assertCurrent: guard });
        if (receipt.status === 'failed' || receipt.status === 'interrupted') throw new Error('DELIVERY_REJECTED');
        return 'queue';
      },
      withdraw: async (id: string, clientId: string, guard: () => void) => {
        guard();
        const receipt = await this.storage.submission(id, clientId);
        if (receipt?.targetPlugin && receipt.status === 'queued' && this.activeSubmissions.get(id) !== clientId)
          await this.removeQueued(id, clientId, { source: 'local', assertCurrent: guard });
      },
      close: () => { if (this.pluginTargetValidator === validate) this.pluginTargetValidator = undefined; },
    };
  }
  readonly orcaStore: TerminalOrcaStore;
  private readonly orcaRemoteController: ReturnType<typeof createOrcaRemoteWorkers>;
  readonly orcaTeamService: OrcaTeamService;
  readonly orcaLifecycle: ReturnType<typeof createTerminalOrcaLifecycle>['lifecycle'];
  readonly orcaTools: ReturnType<typeof createTerminalOrcaTools>;
  private readonly orcaIpc: ReturnType<typeof createTerminalOrcaIpc>;
  readonly orcaReports: TerminalOrcaReports;
  readonly orcaIdle: ReturnType<typeof createOrcaIdleReleaseWatcher>;
  private readonly orcaAction = new AsyncLocalStorage<() => void>();
  private readonly orcaBootOptions = new Map<string, MakerSessionCreateOpts>();
  private readonly manualOrcaInterrupts = new Map<string, OrcaManualInterruptSnapshot>();
  readonly orcaDispatcher: ReturnType<typeof createOrcaInterAgentDispatcher<TerminalTaskMeta>>;
  readonly orcaQueue: TerminalOrcaQueue;
  readonly changes: TerminalTaskChanges;
  readonly turnLifecycle: TerminalTurnLifecycle;
  readonly channelSignals: ReturnType<typeof createChannelTurnSignals>;
  readonly channelRecovery: ReturnType<typeof createRuntimeRecoveryNotices>;
  readonly taskContext: TerminalTaskContext;
  readonly routes: TerminalTaskRoutes;
  private readonly remoteWorkerForwarder: ReturnType<typeof createOrcaRemoteWorkerForwarder>;
  private readonly remoteWorkerTurns = new Map<string, { instanceId: string; generation: number; clientId: string }>();
  private readonly remoteWorkers: ReturnType<typeof createTerminalRemoteWorkerHost>;
  private readonly routeClosures = new Set<string>();
  private readonly permissionChanges = createSessionPermissionChanges();
  private readonly utilityAbort = new AbortController();
  readonly utility: TerminalUtilityModels;
  private readonly utilityWork = new Set<Promise<unknown>>();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly externalSubmissions = new Map<string, string>();
  private readonly stoppingTasks = new Map<string, number>();
  private readonly storageReady: Promise<void>;
  readonly media: TerminalTaskMedia;
  readonly capabilities: TerminalCapabilities;
  readonly channelFiles: ReturnType<typeof createInboundFileStaging>;
  readonly channelBindings: TerminalImBindings;
  readonly channelDefaults: TerminalImDefaults;
  readonly channelControl: TerminalImControl;
  readonly channelOrchestrators: TerminalImOrchestrators;
  readonly channelSessionDefaults: ReturnType<typeof createImSessionDefaults>;
  private readonly live = new Map<string, LiveTask>();
  private readonly starts = new Map<string, Promise<LiveTask>>();
  private pluginSessions?: TerminalPluginSessionHooks;
  private pluginFactory?: (context:PluginTaskContext)=>Promise<TerminalPluginTask>;
  private pluginSetup?:TerminalPluginSetup;
  private readonly channelPluginSurface = createGhostSetupInteractionSurface();
  private knowledge?: Pick<TerminalKnowledge, 'createRuntime' | 'snapshot'>;
  private channelTools?: (context: () => import('@cindy/mcps').LiziMcpSessionContext, metadata: { source?: string }) => NonNullable<Parameters<typeof createTaskTools>[0]['extraFactories']>;
  private schedulerDeps?: import('../../../../packages/lizi-mcps/src/types.js').SchedulerMcpDeps;
  private readonly taskObservers = new Map<string,Set<(event:AgentEvent)=>void>>();
  private readonly makerObservers = new Set<MakerEventListener>();
  private readonly engineCapabilities = new Map<AgentKind, Capabilities>();
  private readonly channelVendorOptions = new Map<string, Record<string, unknown>>();
  private channelMaker?: ReturnType<ImTurnHost['getMaker']>;
  private channelHost?: ImTurnHost;
  private channelCards?: ImCardHost;
  private readonly channelHydration = new Map<string, { providerId?: string | null; effort?: import('@cindy/maker-core').Effort; fastMode?: boolean | 'ultrafast' }>();
  private readonly pending = new Map<string, Pending>();
  private readonly queuedSubmissions = new Map<string, Array<{ requestId: string; message: UserMessage; context: TaskInvocationContext; sendAtMs?: number }>>();
  private readonly queuePaused = new Set<string>();
  private readonly queueMutations = new Set<string>();
  private readonly steeringSubmissions = new Map<string, { clientId: string; controller: AbortController }>();
  private readonly steerOperations = new Set<Promise<ControlSteerOutcome>>();
  private readonly queueLocks = new Map<string, Set<string>>();
  private readonly queueEditLocks = new Map<string, Set<string>>();
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly submissionText = new Map<string, string>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly receiptListeners = new Set<(receipt: Submission) => void>();
  private readonly sending = new Set<string>();
  private readonly groupBindings = new Map<string, import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding>();
  private readonly hostedRuntimeIds = new Set<string>();
  private hostedWrites: Promise<void> = Promise.resolve();
  private readonly hosted = new Set<import('@cindy/maker-core').AgentSessionHandle>();
  private readonly binaries = new Map<AgentKind, string | null>();
  private readonly authCache = new Map<AgentKind, { at: number; value: Awaited<ReturnType<typeof nativeAuthState>> }>();
  readonly ready: Promise<void>;
  private pendingDispatchReady:boolean;
  private closed = false;
  private closing?: Promise<void>;
  private readonly persistenceFaults = new Set<string>();

  constructor(private readonly options: TerminalTaskHostOptions) {
    this.channelSignals = createChannelTurnSignals(options.logger);
    this.channelRecovery = createRuntimeRecoveryNotices(options.runtimeRecoveryMessage ?? (() => 'Pi extensions could not be refreshed. Restart Cindy before using Pi again.'));
    this.channelFiles = createInboundFileStaging({
      createLogger: () => options.logger,
      ownerScopedImUserDataPath: (...segments) => {
        if (this.closed) throw new Error('TASK_HOST_CLOSED');
        return path.join(options.profileDir, ...segments);
      },
      ensureDirectory: privateDirectory,
    });
    this.pendingDispatchReady=!options.deferPendingTasks;
    if (!path.isAbsolute(options.profileDir)) throw new Error('PROFILE_DIRECTORY_MUST_BE_ABSOLUTE');
    this.media = new TerminalTaskMedia(options.profileDir);
    this.storage = new TerminalTaskStorage(path.join(options.profileDir, 'tasks'));
    this.taskContext = new TerminalTaskContext({ storage: this.storage, assertCurrent: () => this.guard({ source: 'local' }), messages: (id, limit) => this.contextMessages(id, limit), warn: message => options.logger.warn(message) });
    this.changes = new TerminalTaskChanges({
      profileDir: options.profileDir, storage: this.storage, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      activeWorkspaces: () => [...this.live.values()].filter(task => this.isTurnRunning(task.session.id)).map(task => task.session.workDir),
      userMessageIds: async id => new Set((await this.messages(id, { limit: Infinity }, true)).filter(row => row.role === 'user').map(row => row.clientId)),
      emit: (channel, payload) => this.emit(channel, payload),
    });
    this.turnLifecycle = new TerminalTurnLifecycle({
      profileDir: options.profileDir, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      beforeStart: async session => { this.changes.assertCanDispatch(session.workDir); await this.channelSignals.publishChannelTurn(session, 'starting'); },
      undispatched: async session => { this.changes.store.clearPendingTurnChangeSets(session.id); await this.channelSignals.publishChannelTurn(session, 'undispatched'); },
      providerInitiated: session => { void this.channelSignals.publishProviderInitiatedTurn(session); },
      hasQueuedWork: id => Boolean(this.queuedSubmissions.get(id)?.length),
      persistContinuation: async (session, text, origin) => {
        this.guard({ source: 'local' });
        this.channelRecovery.advanceRuntimeRecoveryNotice(session);
        const agentMeta = { delivery: 'turn', autoResume: true, ...(origin ? { origin } : {}) };
        const stored = await this.storage.append(session.id, { kind: 'user', message: { type: 'user', content: text }, clientId: randomUUID(), agentMeta });
        this.emit('local-db:messages:created', { sessionId: session.id, message: { id: `${session.id}:${stored.sequence}`, clientId: stored.clientId, sessionId: session.id, role: 'user', content: text, agentMeta, createdAt: new Date(stored.timestamp).toISOString() } });
      },
      settled: async (session, reason) => {
        await this.changes.store.finalizeTurnChangeSet(session.id, null, 'complete');
        if (reason !== 'skip') this.onEvent(session.id, { type: 'error', data: { reason: 'silent-stop-exhausted', isTerminal: true, message: options.silentStopMessage?.() ?? 'The model repeatedly returned empty responses. Send a message to continue.' } });
        else {
          const requestId = this.activeSubmissions.get(session.id);
          if (requestId) { this.activeSubmissions.delete(session.id); await this.updateReceipt(session.id, requestId, 'completed', undefined, this.submissionText.get(session.id)); this.submissionText.delete(session.id); }
          setImmediate(() => this.drain(session.id));
        }
        this.emit('maker:event', { sessionId: session.id, event: { type: 'status', data: { isRunning: false } } });
      },
    });
    this.storageReady = this.storage.open();
    this.orcaStore = new TerminalOrcaStore({ root: options.profileDir, tasks: this.storage, beforeOpen: this.storageReady,
      guard: () => this.guard({ source: 'local' }),
      onTaskPatch: (id, patch) => {
        this.emit('local-db:sessions:patched', { sessionId: id, patch: { ...patch, ...(patch.archived ? { status: 'archived' } : {}) } });
        this.emit('terminal:tasks:changed', { sessionId: id });
      },
    });
    this.orcaRemoteController = createOrcaRemoteWorkers({
      getOwnerToken: () => this.closed ? null : this,
      getTeamService: () => this.orcaTeamService,
      listDevices: async () => {
        if (!options.listOrcaDevices) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        return options.listOrcaDevices();
      },
      remoteInvoke: async (device, channel, args) => {
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const response = await options.remoteInvoke(device, channel, args);
        return response.ok ? { ok: true, result: response.result } : { ok: false,
          error: { code: 'IPC_ERROR', message: `[${response.error?.code ?? 'INTERNAL'}] ${response.error?.message ?? 'Remote invocation failed'}` } };
      },
      readLeadTitle: async id => (await this.storage.get(id))?.title ?? '',
      broadcastOrcaWorkerChanged: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      log: options.logger,
      store: {
        archiveSingleWorkerSession: async (id, beforeMutation) => {
          await beforeMutation?.(); this.guard({ source: 'local' });
          await this.patchMeta(id, { status: 'archived' }, () => this.guard({ source: 'local' }));
        },
        getRemoteWorkerByProxySession: id => this.orcaStore.getRemoteWorkerByProxySession(id),
        listActiveRemoteWorkers: () => this.orcaStore.listActiveRemoteWorkers(),
        listUnreleasedEndedRemoteWorkers: () => this.orcaStore.listUnreleasedEndedRemoteWorkers(),
        markWorkerRemoteReleased: (id, at) => this.orcaStore.markWorkerRemoteReleased(id, at),
        markWorkerRemoteStopConfirmed: (id, at) => this.orcaStore.markWorkerRemoteStopConfirmed(id, at),
        getWorkerRemoteReleaseState: id => this.orcaStore.getWorkerRemoteReleaseState(id),
        saveWorkerRemoteReport: (id, pending, message, done) => this.orcaStore.saveWorkerRemoteReport(id, pending, message, done),
        saveRemoteWorkerOpen: (device, id) => this.orcaStore.saveRemoteWorkerOpen(device, id),
        removeRemoteWorkerOpen: id => this.orcaStore.removeRemoteWorkerOpen(id),
        listOrphanRemoteWorkerOpens: id => this.orcaStore.listOrphanRemoteWorkerOpens(id),
        addRemoteWorker: input => this.orcaStore.addRemoteWorker(input),
        removeWorker: id => this.orcaStore.removeWorker(id),
      },
    });
    this.orcaStore.setRemoteWorkerStatusProvider((session, device) => this.orcaRemoteController.runtime.isRemote(session) ? ({
      deviceName: this.orcaRemoteController.deviceName(device),
      reachable: this.orcaRemoteController.runtime.isReachable(session),
    }) : undefined);
    this.channelBindings = new TerminalImBindings({ root: options.profileDir, logger: options.logger, beforeOpen: this.storageReady, assertCurrent: () => { if (this.closed) throw new Error('TASK_HOST_CLOSED'); } });
    this.channelDefaults = new TerminalImDefaults({ root: options.profileDir, assertCurrent: () => this.guard({ source: 'local' }), changed: channel => this.emit('maker:remote-resources:changed', { collectionId: 'channels', channel }) });
    this.channelSessionDefaults = createImSessionDefaults({
      getCapabilities: kind => this.channelRuntime().getCapabilities(kind),
      listProviders: () => this.models.views(),
      readImDefaultSettings: channel => this.channelDefaults.read(channel),
      readImRemoteProviderRoute: route => readRemoteProviderRoute(route, async (deviceId, channel, args) => {
        this.guard({ source: 'local' });
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const result = await options.remoteInvoke(deviceId, channel, args);
        this.guard({ source: 'local' });
        return result;
      }),
      log: options.logger,
    });
    this.capabilities = new TerminalCapabilities({root:options.profileDir,secrets:options.secretStore,assertCurrent:()=>{if(this.closed)throw new Error('TASK_HOST_CLOSED');},changed:()=>{this.emit('maker:mcp:changed',{});this.emit('maker:remote-resources:changed',{collectionId:'skills'});this.emit('maker:remote-resources:changed',{collectionId:'mcp'});},workingDirs:async()=>[...new Set((await this.storage.list()).filter(row=>!row.deleted).map(row=>row.workDir))]});
    this.models = new TerminalModelConfig(options.profileDir, options.secretStore, kind => this.authState(kind), options.catalog, options.createAgent ? undefined : async kind => { const binary = this.binaries.get(kind); return binary ? discoverNativeModels(kind, binary, options.profileDir, options.logger) : []; }, options.region);
    this.utility = new TerminalUtilityModels({
      root: options.profileDir, models: this.models, log: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      changed: () => this.emit('maker:remote-resources:changed', { collectionId: 'auxiliary-models' }),
      native: {
        listAvailableAgents: () => this.binaries.has('codex') ? ['codex'] : [],
        getAgentAuthState: async kind => { await this.ready; return this.authState(kind); },
        oneShot: (kind, prompt, opts) => this.nativeUtilityText(kind, prompt, opts),
      },
    });
    this.routes = new TerminalTaskRoutes({
      storage: this.storage, context: this.taskContext, models: this.models, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      getSession: id => this.live.get(id)?.session,
      hasPendingInteraction: id => [...this.pending.values()].some(pending => pending.sessionId === id),
      closeSession: id => this.closeTask(id), bootstrap: async id => { await this.ensureLive(id); },
      select: input => this.selection(input), messages: id => this.contextMessages(id, Infinity),
      withCloseSuppressed: async (id, run) => {
        const previous = this.routeClosures.has(id); this.routeClosures.add(id);
        try { return await run(); } finally { if (!previous) this.routeClosures.delete(id); }
      },
      changed: async (id, boundary) => {
        const row = await this.storage.get(id); if (!row) return;
        this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
        if (boundary) {
          const message = (await this.messages(id, { limit: Infinity }, true)).find(message => message.clientId === (boundary.kind === 'context-rebuild' ? `${boundary.clientId}:card` : boundary.clientId));
          if (message) this.emit('local-db:messages:created', { sessionId: id, message });
        }
      },
      pendingChanged: (id, intent) => this.emit('local-db:sessions:patched', { sessionId: id, patch: { agentSwitchIntent: intent } }),
      replay: (...args) => this.replayRecoveredTask(...args),
      hasExternalOwner: id => Boolean(this.channelBindings.store.findByTarget(id) || this.pluginSetup?.surface.isHeadlessGhostSetupTurn(id)),
    });
    const currentWorkerTurn = (id: string) => {
      const turn = this.remoteWorkerTurns.get(id), session = this.live.get(id)?.session;
      return turn && session?.instanceId === turn.instanceId && session.getTurnGeneration() === turn.generation ? turn : undefined;
    };
    this.remoteWorkerForwarder = createOrcaRemoteWorkerForwarder({
      getOwnerToken: () => this.closed ? null : this,
      readSession: async id => { const row = await this.storage.get(id); return row ? { status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', orcaRemoteLead: row.orcaRemoteLead ?? null } : null; },
      remoteInvoke: async (device, channel, args) => {
        this.guard({ source: 'local' });
        if (!options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
        const result = await options.remoteInvoke(device, channel, args);
        return result.ok ? { ok: true, result: result.result } : { ok: false, error: { code: result.error?.code ?? 'IPC_ERROR', message: result.error?.message ?? 'Remote worker bridge unavailable' } };
      },
      getActiveInputClientIds: id => { const turn = currentWorkerTurn(id); return turn ? [turn.clientId] : []; },
      getAcceptedInputProvenance: id => currentWorkerTurn(id) ? { originKind: 'orca' } : null,
    });
    this.remoteWorkers = createTerminalRemoteWorkerHost({
      storage: this.storage, deviceId: options.deviceId, workerBridge: Boolean(options.remoteInvoke),
      guard: context => this.guard(context), withLock: (id, work) => this.routes.withLock(id, work),
      providers: deviceId => deviceId
        ? options.remoteInvoke ? readDeviceProviderViews(options.remoteInvoke, deviceId) : Promise.reject(new Error('REMOTE_AGENT_UNAVAILABLE'))
        : this.models.views(),
      locations: () => options.remoteWorkerLocations?.() ?? Promise.resolve([]),
      create: async (request, lead, guard) => {
        await this.create({ ...request }, guard, undefined, { id: request.sessionId, lead });
        guard(); const row = await this.storage.get(request.sessionId); guard();
        if (!row) throw new Error('TASK_NOT_FOUND'); return row;
      },
      changed: row => { this.emit('terminal:tasks:changed', { sessionId: row.id }); this.emit('local-db:sessions:patched', { sessionId: row.id, patch: this.guiSession(row) }); },
    });
    this.channelControl = new TerminalImControl({ tasks: this, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      readDeviceProviders: id => {
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        return readDeviceProviderViews(options.remoteInvoke, id);
      },
    });
    this.channelOrchestrators = new TerminalImOrchestrators(this);
    this.orcaDispatcher = this.createOrcaDispatcher();
    this.orcaQueue = new TerminalOrcaQueue({ storage: this.storage, store: this.orcaStore,
      assertCurrent: () => this.guard({ source: 'local' }),
      mutate: (id, work) => this.mutateQueued(id, work),
      consuming: (id, clientId) => this.activeSubmissions.get(id) === clientId || this.steeringSubmissions.get(id)?.clientId === clientId,
      locked: (id, clientId) => this.queueEditLocks.get(id)?.has(clientId) === true || !!this.queueLocks.get(id)?.size,
      normalize: (id, input) => this.message(id, input, { source: 'local' }),
      changed: async (id, rows) => {
        const queue = this.queuedSubmissions.get(id) ?? [];
        for (const row of rows) {
          const index = queue.findIndex(item => item.requestId === row.requestId);
          if (index >= 0) {
            if (row.status !== 'queued') queue.splice(index, 1);
            else if (row.message) { queue[index]!.message = row.message; queue[index]!.context.collaboration = row.collaboration; }
          }
          if (row.plugin) await this.pluginSessions?.onSubmission(row);
          this.emit('terminal:tasks:submission', row);
          for (const listener of this.receiptListeners) listener(row);
        }
        this.emit('maker:input:projection', await this.projection(id));
      },
      reordered: (id, ids) => {
        const queue = this.queuedSubmissions.get(id) ?? [];
        queue.sort((a, b) => ids.indexOf(a.requestId) - ids.indexOf(b.requestId));
        void this.projection(id).then(value => this.emit('maker:input:projection', value)).catch(() => undefined);
      },
      discard: id => this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(id),
    });
    this.orcaTeamService = this.createOrcaTeamControls();
    this.orcaReports = new TerminalOrcaReports({ storage: this.storage, store: this.orcaStore,
      guard: () => this.guard({ source: 'local' }),
      dispatch: input => this.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(input),
      withWorkerLock: (id, work) => this.routes.withLock(id, work),
      settled: id => { this.orcaTeamService.clearAutoBridgeState(id); void this.orcaStore.getWorkerLink({ workerSessionId: id })
        .then(link => { if (link) this.emit('maker:orca:worker-changed', { leadSessionId: link.leadSessionId }); }).catch(() => undefined); },
      warn: () => options.logger.warn('ORCA_REPORT_RECOVERY_FAILED'),
    });
    this.orcaLifecycle = createTerminalOrcaLifecycle({
      store: this.orcaStore, tasks: this.storage, models: this.models, team: this.orcaTeamService, remote: this.orcaRemoteController,
      remoteInvoke: options.remoteInvoke, selfDeviceId: () => options.deviceId,
      guard: () => { this.guard({ source: 'local' }); this.orcaAction.getStore()?.(); },
      withLock: (id, work) => this.routes.withLock(id, work),
      authority: id => this.captureOrcaAuthority(id),
      validatePlan: async (...args) => {
        const row = await this.storage.get(args[0].leadSessionId);
        if (this.pluginSessions?.validateWorkerPlan) return this.pluginSessions.validateWorkerPlan(...args);
        if (row?.source === 'plugin') throw new Error('PLUGIN_TASK_AUTHORITY_UNAVAILABLE');
        await args[3]?.(); return undefined;
      },
      bootstrap: async input => {
        const id = string(input.id), current = this.orcaAction.getStore();
        if (input.remoteHostId) throw new Error('SSH_TASK_ROUTE_REQUIRED');
        this.orcaBootOptions.set(id, input);
        try {
          await this.create(input, () => { this.guard({ source: 'local' }); current?.(); }, undefined, undefined, { id, role: 'worker' });
          const task = this.live.get(id);
          if (!task) throw new Error('TASK_NOT_ACTIVE');
          return { session: task.session, didInjectOrcaInstructions: task.didInjectOrcaInstructions, didInjectProjectContext: false };
        } finally { this.orcaBootOptions.delete(id); }
      },
      live: id => this.live.get(id)?.session,
      close: id => this.closeTask(id),
      archive: async id => { await this.patchMeta(id, { status: 'archived' }, () => this.guard({ source: 'local' })); },
      forget: id => { this.manualOrcaInterrupts.delete(id); this.orcaTeamService.clearAutoBridgeState(id); },
      readyMessage: async (id, message, current) => {
        await current?.();
        const task = await this.ensureLive(id);
        const result = await task.session.send({ type: 'user', content: message }, {
          planMode: false, throwOnStartFailure: true, onAccepted: current,
          [AUTO_REVIEW_SOURCE_CONTENT]: '', [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
        });
        if (!result.accepted) throw new Error('ORCA_WORKER_READY_FAILED');
      },
      changed: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      created: sessionId => this.emit('local-db:sessions:created', { sessionId }),
    }).lifecycle;
    this.orcaTools = createTerminalOrcaTools({
      store: this.orcaStore, tasks: this.storage, lifecycle: this.orcaLifecycle, team: this.orcaTeamService, remote: this.orcaRemoteController,
      selfDeviceId: options.deviceId,
      providers: id => id ? options.remoteInvoke ? readDeviceProviderViews(options.remoteInvoke, id) : Promise.reject(new Error('REMOTE_AGENT_UNAVAILABLE')) : this.models.views(),
      locations: () => options.remoteWorkerLocations?.() ?? Promise.resolve([]),
      authorize: ctx => async input => {
        const current = this.orcaMcpGuard(ctx, input.sessionId);
        current();
        return { ok: true, run: async operation => this.orcaAction.run(current, async () => { current(); const result = await operation(); current(); return result; }) };
      },
      authority: id => this.captureOrcaAuthority(id), live: id => this.live.get(id)?.session,
      resume: (id, current) => this.routes.withLock(id, async () => {
        await current(); const row = await this.storage.get(id);
        if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
        await current(); await this.ensureLive(id); await current();
      }),
      end: id => this.endOrca(id),
      latestText: async id => (await this.messages(id, { limit: Infinity }, true)).find(row => row.role === 'assistant')?.content ?? '',
      running: id => this.isTurnRunning(id), paused: id => this.queuePaused.has(id),
      changed: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      warn: error => options.logger.warn('ORCA_WORKER_RESUME_FAILED', { error: String(error) }),
    });
    this.orcaIpc = createTerminalOrcaIpc({ store: this.orcaStore, lifecycle: this.orcaLifecycle, team: this.orcaTeamService, api: this.orcaTools.api,
      authority: id => this.captureOrcaAuthority(id), remote: id => this.orcaRemoteController.runtime.isRemote(id),
      hasUserMessageSince: async (id, at) => (await this.messages(id, { limit: Infinity }, true)).some(message => message.role === 'user' && Date.parse(message.createdAt) >= at),
    });
    this.orcaIdle = createOrcaIdleReleaseWatcher({
      readIdleReleaseMinutes: () => this.orcaStore.settings().workerIdleReleaseMinutes,
      listCandidates: at => this.orcaStore.idleCandidates(at), getSession: id => this.live.get(id)?.session ?? null,
      withSessionLock: (id, work) => this.routes.withLock(id, work),
      hasPendingInput: async id => this.isTurnRunning(id) || (await this.storage.queued(id)).length > 0 || [...this.pending.values()].some(request => request.sessionId === id),
      markReleased: (candidate, at) => this.orcaStore.markIdleReleased(candidate, at), touchWorker: (id, at) => this.orcaStore.touchWorker(id, at),
      closeSession: id => this.closeTask(id), broadcastWorkerChanged: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      now: Date.now, timer: { setInterval: (work, delay) => { const timer = setInterval(work, delay); timer.unref(); return timer; }, clearInterval }, log: options.logger,
    });
    this.channelBindings.store.onChange(event => this.emit('binding:changed', {
      sessionId: event.value, attached: event.value !== null, channel: event.identity.channel, userId: event.identity.userId,
    }));
    this.ready = this.initialize();
    void this.ready.then(() => { if (!this.closed) this.orcaReports.start(); }).catch(() => undefined);
  }
  private async initialize() {
    await privateDirectory(this.options.profileDir);
    const initialized=await Promise.allSettled([this.storageReady,this.orcaStore.ready,this.models.open(),this.media.ready,this.capabilities.ready,this.channelBindings.ready,this.channelDefaults.ready,this.utility.ready,...ENGINES.map(async kind=>this.binaries.set(kind,await findAgentBinary(kind,this.options.binaryPaths?.[kind])))]);
    const failed=initialized.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
    for (const id of this.channelBindings.store.listAttachedTargets()) {
      const row = await this.storage.get(id);
      const identity = this.channelBindings.store.findByTarget(id);
      if (identity && (!row || row.deleted || row.archived)) await this.channelBindings.store.detachIfTarget(identity, id);
    }
    for (const kind of ENGINES) this.engineCapabilities.set(kind, ({'claude-code':ClaudeCodeAgent,codex:CodexAgent,pi:PiAgent}[kind]).getDeclaredCapabilities());
    const hostedFile=await readPrivateFile(path.join(this.options.profileDir,'hosted-runtimes.json'));
    if(hostedFile){const ids=JSON.parse(hostedFile.toString());if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw new Error('INVALID_HOSTED_RUNTIME_INDEX');for(const id of ids)this.hostedRuntimeIds.add(id);}
    for (const row of await this.storage.list()) {
      if (row.queuePaused) this.queuePaused.add(row.id);
      if (row.groupBinding) this.groupBindings.set(row.id, row.groupBinding);
      const queued = await this.storage.queued(row.id);
      for (const receipt of queued) if (receipt.message) this.enqueueSubmission(row.id, receipt.message, receipt.requestId, { source: receipt.source ?? 'local', deviceId: receipt.deviceId, sourceDevice: receipt.sourceDevice, ownerId: receipt.ownerId, scheduler: receipt.scheduler, sender:receipt.sender, plugin:receipt.plugin, targetPlugin:receipt.targetPlugin, orca:receipt.orca, collaboration:receipt.collaboration, deliveryProof: receipt.deliveryProof, ...(receipt.sharedTask ? { sharedTask: receipt.sharedTask, assertCurrent: () => { throw new Error('SHARED_TASK_REVALIDATION_REQUIRED'); } } : {}) }, receipt.sendAtMs);
    }
    this.guard({ source: 'local' });
    await this.orcaRemoteController.start();
    this.guard({ source: 'local' });
    this.orcaIdle.start();
  }
  private orcaMcpGuard(context: McpProviderContext, expectedId?: string): () => void {
    const ctx = context.getSessionContext ? context.getSessionContext() : context;
    if (!ctx?.sessionId || expectedId && ctx.sessionId !== expectedId) throw new Error('TASK_MCP_SCOPE_MISMATCH');
    const id = ctx.sessionId, instance = ctx.sessionInstanceId;
    const session = this.live.get(id)?.session;
    if (!instance || !session || session.instanceId !== instance) throw new Error('TASK_MCP_SCOPE_MISMATCH');
    return () => { this.guard({ source: 'local' }); if (this.live.get(id)?.session !== session || session.getStatus() !== 'active') throw new Error('TASK_MCP_SCOPE_REVOKED'); };
  }
  private async endOrca(id: string) {
    return this.routes.withLock(id, async () => {
      const authority = await this.captureOrcaAuthority(id), team = await this.orcaStore.getActiveTeamByLead(id);
      await authority.assertCurrent();
      if (team) {
        for (const worker of await this.orcaStore.listWorkersByLead(id)) {
          await authority.assertCurrent();
          const result = await this.orcaTeamService.archiveWorker({ callerLeadSessionId: id, workerId: worker.id, beforeArchive: authority.assertCurrent });
          if (!result.ok) throw new Error(result.message);
        }
        await authority.assertCurrent(); await this.orcaStore.markTeamEnded(team.id, 'completed');
        await this.orcaStore.markWorkerStatusesByTeam(team.id, 'done');
      } else {
        for (const worker of await this.orcaStore.reconcileInactiveTeamWorkersForLead(id)) {
          await authority.assertCurrent(); await this.closeTask(worker);
          this.orcaTeamService.clearAutoBridgeState(worker);
        }
      }
      await authority.assertCurrent(); await this.orcaStore.setSessionOrcaRole(id, null);
      await this.live.get(id)?.session.setVendorOptions({ orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null, initialWorker: null });
      this.emit('maker:orca:worker-changed', { leadSessionId: id });
    });
  }
  private localWorkerMcpProvider(id: string): McpProvider {
    return { name: 'orca_worker_bridge', toClaudeSdkConfig: context => {
      const current = () => this.orcaMcpGuard(context, id)();
      const linkForCaller = async (input: { workerId?: string; workerSessionId?: string }) => {
        current();
        if (input.workerSessionId && input.workerSessionId !== id) throw new Error('TASK_MCP_SCOPE_MISMATCH');
        const link = await this.orcaStore.getWorkerLink({ ...input, workerSessionId: id });
        if (!link) return null;
        const [team, worker, lead] = await Promise.all([this.orcaStore.getActiveTeamByLead(link.leadSessionId), this.storage.get(id), this.storage.get(link.leadSessionId)]);
        current();
        return team?.id === link.teamId && worker && !worker.deleted && !worker.archived && lead && !lead.deleted && !lead.archived ? link : null;
      };
      return createOrcaWorkerBridgeMcpProvider({
        logger: this.options.logger, sharedBridge: true, manageWorkerStatus: false,
        ensureSession: async meta => { current(); const link = await linkForCaller({ workerSessionId: id });
          if (link?.leadSessionId !== meta.sessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const task = await this.ensureLive(meta.sessionId); current(); return task.session; },
        orcaTeamStore: {
          getWorkerLink: async input => {
            const link = await linkForCaller(input);
            if (!link) return null;
            const { effort, ...leadSession } = link.leadSession;
            return { ...link, workflowId: link.teamId, leadSession: { ...leadSession,
              ...(effort ? { effort: effort as import('@cindy/maker-core').Effort } : {}) } };
          },
          updateWorkerStatus: async (workerId, status) => { const link = await linkForCaller({ workerId }); if (!link) throw new Error('ORCA_ASSIGNMENT_REVOKED'); await this.orcaStore.updateWorkerStatus(workerId, status); },
        },
        persistUserMessage: async (target, message) => { current(); await this.storage.append(target, { kind: 'user', clientId: message.clientId, message: { type: 'user', content: message.content } }); },
        readLeadHistory: async input => {
          const link = await linkForCaller({ workerSessionId: id });
          if (link?.leadSessionId !== input.leadSessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const page = await createRemoteHistory(this.historyDeps(), taskId => this.storage.get(taskId), current).messages({
            sessionId: input.leadSessionId, fromMs: input.fromMs, toMs: null, roles: ['user', 'assistant'],
            workdir: null, agentKind: null, limit: input.limit, cursor: input.cursor, order: 'asc', includeRewound: false });
          current(); return { ...page, items: page.items.flatMap(item => item.role === 'user' || item.role === 'assistant'
            ? [{ ...item, role: item.role, agentMeta: item.agentMeta ?? null }] : []) };
        },
        dispatchInterAgentMessage: async input => {
          const link = await linkForCaller({ workerId: input.workerId, workerSessionId: id });
          if (input.source !== 'worker' || link?.leadSessionId !== input.targetSessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const capture = this.orcaTeamService.captureWorkerTerminalTurn(id);
          const requestId = this.activeSubmissions.get(id);
          const result = await this.orcaReports.manual(id, requestId, input);
          if (result.ok) {
            await this.orcaTeamService.settleReportedWorker(capture);
            await this.orcaReports.markSettled(id, requestId);
          }
          return result;
        },
      }).toClaudeSdkConfig(context);
    } };
  }
  private async captureOrcaAuthority(id: string) {
    const current = this.orcaAction.getStore();
    const row = await this.storage.get(id);
    if (!row || row.archived || row.deleted || row.orcaRole === 'worker' || row.orcaRemoteLead && row.orcaRemoteLead.releasedAt === undefined) throw new Error('ORCA_LEAD_UNAVAILABLE');
    const plugin = this.pluginSessions?.captureOrcaAuthority
      ? await this.pluginSessions.captureOrcaAuthority(id, this.activeSubmissions.get(id)) : undefined;
    if (!plugin && row.source === 'plugin') throw new Error('PLUGIN_TASK_AUTHORITY_UNAVAILABLE');
    const assertCurrent = async () => {
      this.guard({ source: 'local' }); current?.();
      const latest = await this.storage.get(id);
      if (!latest || latest.archived || latest.deleted || latest.source !== row.source || latest.orcaRole === 'worker') throw new Error('ORCA_LEAD_UNAVAILABLE');
      await plugin?.assertCurrent(); this.guard({ source: 'local' }); current?.();
    };
    await assertCurrent(); return { permissionMode: plugin?.permissionMode, assertCurrent };
  }
  private async authState(kind: AgentKind) {
    if (kind === 'codex' && this.models?.openAiAccount()) return { authenticated: this.models.openAiAccount()!.connected(), authSource: 'oauth' as const };
    const cached = this.authCache.get(kind);
    if (cached && Date.now() - cached.at < 15_000) return cached.value;
    const value = await (this.options.nativeStatus ?? nativeAuthState)(kind, this.binaries.get(kind) ?? null);
    this.authCache.set(kind, { at: Date.now(), value });
    return value;
  }
  private createOrcaDispatcher() {
    const createOpts = (row: TerminalTaskMeta) => ({ agentKind: row.agentKind, workingDir: row.workDir,
      model: row.model, providerId: row.providerId, effort: row.effort, fastMode: row.fastMode,
      permissionMode: row.permissionMode, orcaRole: row.orcaRole });
    return createOrcaInterAgentDispatcher<TerminalTaskMeta>({
      createId: randomUUID,
      getSessionMeta: id => this.storage.get(id),
      getSessionRowSnapshot: async id => { const row = await this.storage.get(id); return row ? {
        title: row.title ?? null, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
        userSendAt: row.userSendAt ?? null,
      } : null; },
      getLiveSession: id => this.live.get(id)?.session,
      readAutoReviewHistory: async id => (await this.contextMessages(id, Infinity)).map(row => ({ ...row, agentMeta: row.agentMeta ?? null })),
      // Every terminal turn has a durable receipt, including an idle target.
      // Only explicit same-turn steering may bypass the new-turn queue.
      shouldQueueNewTurn: () => true,
      hasSendToSessionLock: id => this.routes.isLocked(id),
      withSendToSessionLock: (id, work) => this.routes.withLock(id, work),
      hasPendingAgentSwitch: id => this.routes.intent(id) !== null,
      steerControlInput: (id, item, expected) => this.steerOrcaInput(id, item, expected),
      buildCreateOptsForQueuedSession: async (_id, row) => createOpts(row),
      enqueueQueuedMessage: async (id, item) => { await this.enqueueOrcaInput(id, item); },
      reserveNextQueuedMessage: async (id, item, onReserved, beforeReserve) => {
        await this.enqueueOrcaInput(id, item, true, onReserved, beforeReserve);
        return true;
      },
      validateImageAttachments: async paths => {
        const images = [];
        for (const reference of paths) {
          const file = path.isAbsolute(reference) ? reference : (await this.media.resolveManaged(reference)).path;
          const ext = path.extname(file).toLowerCase(), mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[ext];
          const info = await stat(file);
          if (!mimeType || !info.isFile() || info.size > 64 * 1024 * 1024) return { ok: false, message: 'INVALID_IMAGE_ATTACHMENT' };
          images.push({ path: file, name: path.basename(file), ext, size: info.size, mimeType });
        }
        return { ok: true, images };
      },
      resolveWorkerSessionLink: id => this.orcaStore.getWorkerLink({ workerId: id }),
      resolveWorkerSenderLabel: async (id, fallback) => {
        const link = await this.orcaStore.getWorkerLink({ workerId: id });
        return link ? (await this.orcaStore.listWorkersByLead(link.leadSessionId)).find(worker => worker.id === id)?.role ?? fallback : fallback;
      },
      // The shared dispatcher's cold/direct ports retain the same durable
      // ingress if its scheduling policy changes in a future host version.
      sendToSessionInternal: async input => {
        const row = await this.storage.get(input.targetSessionId);
        if (!row || row.deleted || row.archived) return { ok: false, errorCode: 'NOT_FOUND', message: 'TASK_NOT_FOUND' };
        if (input.onAccepted) this.orcaDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(input.clientId,
          input.onAccepted, input.onAcceptedRollback, input.onAcceptedCommit);
        try {
          await this.enqueueOrcaInput(row.id, { clientId: input.clientId, text: input.message, persistedContent: input.persistedContent,
            origin: input.origin, model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'ask', workingDir: row.workDir,
            createOpts: createOpts(row), chatMessage: { clientId: input.clientId, role: 'user', content: input.persistedContent, createdAt: new Date().toISOString() } });
          return { ok: true, targetSessionId: row.id, agentKind: row.agentKind, wakeKind: 'queued', targetTitle: row.title ?? null,
            targetLastUserSendAt: row.userSendAt ? new Date(row.userSendAt).toISOString() : null };
        } catch (error) { this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(input.clientId); throw error; }
      },
      createDbMessage: (id, input) => this.storage.append(id, { kind: 'user', message: { type: 'user', content: input.content },
        clientId: input.clientId, origin: 'local', agentMeta: input.agentMeta }),
      beginDirectTurnChangeSet: async (id, clientId) => { await this.changes.begin((await this.ensureLive(id)).session, clientId); },
      abortDirectTurnChangeSet: id => this.changes.store.clearPendingTurnChangeSets(id),
      isSessionRunningError: error => error instanceof Error && error.message === 'SESSION_RUNNING',
      log: this.options.logger,
    }, this.options.logger);
  }
  private async enqueueOrcaInput(id: string, item: AgentInputQueuedMessage, atHead = false,
    onReserved?: () => void, beforeReserve?: () => Promise<void>) {
    await this.ready;
    return this.mutateQueued(id, async () => {
        await beforeReserve?.();
        const collaboration = await captureTerminalOrcaInput(this.orcaStore, this.storage, id, item);
        const receipt = await this.submit(id, { text: item.text, files: item.files, mentions: item.mentions },
          { requestId: item.clientId }, { source: 'local', collaboration }, atHead);
        await onReserved?.();
        return receipt;
    });
  }
  private async mutateQueued<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.routes.withLock(id, async () => {
      this.queueMutations.add(id);
      try { return await work(); }
      finally { this.queueMutations.delete(id); setImmediate(() => this.drain(id)); }
    });
  }
  private createOrcaTeamControls(): OrcaTeamService {
    const changed = (leadSessionId: string) => this.emit('maker:orca:worker-changed', { leadSessionId });
    const closeIfIdle = async (id: string) => {
      if (this.isTurnRunning(id) || this.steeringSubmissions.has(id) || (await this.storage.queued(id)).length) return false;
      await this.closeTask(id); return true;
    };
    return createOrcaTeamService(this.orcaRemoteController.wrapTeamDeps({
      captureControlAuthority: async leadId => {
        // The shared queue tools also let a Worker manage collaboration input
        // in its own queue. Resolve its real Lead without granting a new team.
        const worker = (await this.storage.get(leadId))?.orcaRole === 'worker'
          ? await this.orcaStore.getWorkerLink({ workerSessionId: leadId }) : null;
        const authorityId = worker?.leadSessionId ?? leadId;
        const authority = await this.captureOrcaAuthority(authorityId);
        const team = await this.orcaStore.getActiveTeamByLead(authorityId);
        if (worker && team?.id !== worker.teamId) throw new Error('ORCA_TEAM_NOT_FOUND');
        return async () => {
          await authority.assertCurrent();
          this.guard({ source: 'local' });
          const [current, row, link] = await Promise.all([this.orcaStore.getActiveTeamByLead(authorityId), this.storage.get(leadId),
            worker ? this.orcaStore.getWorkerLink({ workerSessionId: leadId }) : null]);
          if (current?.id !== team?.id || !row || row.deleted || row.archived || worker && link?.workerId !== worker.workerId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
        };
      },
      getWorkerLinkBySessionId: workerSessionId => this.orcaStore.getWorkerLink({ workerSessionId }),
      getWorkerLinkByWorkerId: workerId => this.orcaStore.getWorkerLink({ workerId }),
      listWorkersByLead: id => this.orcaStore.listWorkersByLead(id),
      getLiveSession: id => this.live.get(id)?.session ?? null,
      resumeWorkerSession: worker => this.routes.withLock(worker.sessionId, async () => {
        const link = await this.orcaStore.getWorkerLink({ workerId: worker.id, workerSessionId: worker.sessionId });
        if (!link || (await this.orcaStore.getActiveTeamByLead(link.leadSessionId))?.id !== link.teamId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
        await this.ensureLive(worker.sessionId);
      }),
      updateWorkerStatus: (id, status) => this.orcaStore.updateWorkerStatus(id, status),
      markWorkerIdle: id => this.orcaStore.markWorkerIdle(id),
      markWorkerIdleIfStatus: (id, status) => this.orcaStore.markWorkerIdleIfStatus(id, status),
      restoreWorkerDoneIfIdle: id => this.orcaStore.restoreWorkerDoneIfIdle(id),
      closeWorkerSession: (id, beforeClose, sendLockHeld) => {
        const close = async () => {
          await beforeClose?.(); this.manualOrcaInterrupts.set(id, { markedAt: Date.now(), reason: 'lead_idle' });
          await this.orcaReports.suppress(id, this.activeSubmissions.get(id));
          const session = this.live.get(id)?.session;
          if (session) await this.turnLifecycle.stop(session);
          await beforeClose?.(); await this.closeTask(id);
        };
        return sendLockHeld ? close() : this.routes.withLock(id, close);
      },
      closeWorkerSessionIfIdle: (id, lockHeld) => lockHeld ? closeIfIdle(id) : this.routes.withLock(id, () => closeIfIdle(id)),
      hasPendingWorkerInput: async id => this.activeSubmissions.has(id) || this.steeringSubmissions.has(id) || this.recovering.has(id)
        || this.sending.has(id) || (await this.storage.queued(id)).length > 0,
      hasSendToSessionLock: id => this.routes.isLocked(id),
      withSessionSendLock: (id, work) => this.routes.withLock(id, work),
      archiveWorkerSession: async (id, beforeMutation) => {
        await beforeMutation?.(); this.manualOrcaInterrupts.set(id, { markedAt: Date.now(), reason: 'lead_archive' });
        await this.patchMeta(id, { status: 'archived' }, () => this.guard({ source: 'local' }));
      },
      getManualInterrupt: id => this.manualOrcaInterrupts.get(id) ?? null,
      clearManualInterrupt: id => { this.manualOrcaInterrupts.delete(id); },
      restoreManualInterrupt: (id, snapshot) => { this.manualOrcaInterrupts.set(id, snapshot); },
      forgetWorkerSession: id => { this.manualOrcaInterrupts.delete(id); this.orcaTeamService.clearAutoBridgeState(id); },
      broadcastOrcaWorkerChanged: changed,
      dispatchWorkerMessage: async params => {
        const result = await this.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, source: 'lead', senderLabel: 'Lead',
          rawContent: params.message, meta: params.dispatchMeta });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      reserveWorkerMessage: async params => {
        const result = await this.orcaDispatcher.reserveNextOrcaInterAgentMessage({ ...params, source: 'lead', senderLabel: 'Lead',
          rawContent: params.message, meta: params.dispatchMeta });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      requestWorkerInterrupt: async id => {
        this.manualOrcaInterrupts.set(id, { markedAt: Date.now(), reason: 'lead_interrupt' });
        await this.orcaReports.suppress(id, this.activeSubmissions.get(id));
        const session = this.live.get(id)?.session;
        const result = session ? await session.requestGracefulStop() : { status: this.starts.has(id) || this.sending.has(id) ? 'unconfirmed' as const : 'no-active-turn' as const };
        return { stopOutcome: result.status, queuePaused: this.queuePaused.has(id) };
      },
      getWorkerQueuePaused: id => this.queuePaused.has(id),
      getSessionQueueSnapshot: async id => ({ pendingQueue: await this.orcaQueue.snapshot(id),
        steeringClientIds: this.steeringSubmissions.has(id) ? [this.steeringSubmissions.get(id)!.clientId] : [],
        consumingClientIds: [this.activeSubmissions.get(id), this.steeringSubmissions.get(id)?.clientId].filter((value): value is string => !!value),
        isWorking: this.isTurnRunning(id), willQueue: true, queuePaused: this.queuePaused.has(id),
      }),
      ensureWorkerQueueRestored: async () => { await this.ready; return !this.closed; },
      removeQueuedMessage: (id, clientId, expected) => this.orcaQueue.remove(id, clientId, expected),
      replaceQueuedMessage: (id, clientId, next, expected) => this.orcaQueue.replace(id, clientId, next, expected),
      mergeQueuedMessages: (id, clientIds, build) => this.orcaQueue.merge(id, clientIds, build),
      moveQueuedMessage: (id, clientId, position) => this.orcaQueue.move(id, clientId, position),
      steerStoredQueuedMessage: (id, clientId) => this.steerQueuedOrcaInput(id, clientId),
      sendAutoBridgeToLead: async (id, message, workerId) => {
        const result = await this.orcaReports.automatic({ targetSessionId: id, rawContent: message,
          source: 'worker', senderLabel: 'Worker', workerId, meta: { source: 'orca', context: `worker_auto_bridge/${id}/${workerId}` } });
        return { accepted: result.ok };
      },
      log: this.options.logger,
    }));
  }
  /** Called with the route lock held, including by the shared dispatcher. */
  private steerOrcaInput(id: string, item: AgentInputQueuedMessage,
    expected: { session: object; turnGeneration: number }, targetPlugin?: { id: string; name: string }): Promise<ControlSteerOutcome> {
    const operation = this.performOrcaSteer(id, item, expected, targetPlugin);
    this.steerOperations.add(operation);
    void operation.finally(() => this.steerOperations.delete(operation)).catch(() => undefined);
    return operation;
  }
  private async performOrcaSteer(id: string, item: AgentInputQueuedMessage,
    expected: { session: object; turnGeneration: number }, targetPlugin?: { id: string; name: string }): Promise<ControlSteerOutcome> {
    const session = this.live.get(id)?.session;
    const currentTurn = () => this.live.get(id)?.session === session && session === expected.session
      && session.getTurnGeneration() === expected.turnGeneration && session.isTurnRunning();
    const blocked = () => this.stoppingTasks.has(id) || this.queuePaused.has(id) || this.recovering.has(id)
      || this.sending.has(id) || !!this.queueLocks.get(id)?.size || this.queueEditLocks.get(id)?.has(item.clientId) === true
      || [...this.pending.values()].some(pending => pending.sessionId === id) || this.routes.intent(id) !== null;
    if (!session || !currentTurn() || blocked() || this.steeringSubmissions.has(id)) return 'not-attempted';
    if (!session.capabilities.sameTurnSteer.supported) return 'not-attempted';
    const collaboration = targetPlugin ? undefined : await captureTerminalOrcaInput(this.orcaStore, this.storage, id, item);
    const validate = () => targetPlugin ? this.assertPluginTargetInput(id, item.clientId)
      : assertTerminalOrcaInput(this.orcaStore, this.storage, id, collaboration!);
    await validate();
    if (!currentTurn() || blocked()) return 'not-attempted';
    const controller = new AbortController(), boundary = { clientId: item.clientId, controller };
    this.steeringSubmissions.set(id, boundary);
    let providerBoundaryReached = false, providerAccepted = false;
    const removeWaiting = () => {
      const queue = this.queuedSubmissions.get(id), index = queue?.findIndex(row => row.requestId === item.clientId) ?? -1;
      if (index >= 0) queue!.splice(index, 1);
    };
    try {
      let receipt = await this.storage.submission(id, item.clientId);
      if (!receipt) receipt = await this.submit(id, { text: item.text, files: item.files, mentions: item.mentions },
        { requestId: item.clientId }, { source: 'local', collaboration, targetPlugin });
      if (receipt.status !== 'queued' || !receipt.message || !(receipt.collaboration || receipt.targetPlugin)) return 'rejected';
      const message = receipt.message;
      await validate();
      if (!currentTurn() || blocked() || controller.signal.aborted) return 'not-attempted';
      // A crash after the RPC starts leaves an interrupted receipt, never a
      // replayable queued row. Only a confirmed non-delivery can restore it.
      if (!await this.updateReceipt(id, item.clientId, 'sending')) throw new Error('SUBMISSION_PERSISTENCE_FAILED');
      const attribution = targetPlugin ? { sourcePlugin: { pluginId: targetPlugin.id, name: targetPlugin.name } }
        : { origin: receipt.collaboration!.origin };
      const source = buildMessageSourceNote(messageSourceSenderFromMeta(attribution));
      await session.steer(source ? appendInputText(message, source) : message, {
        signal: controller.signal, [AUTO_REVIEW_SOURCE_CONTENT]: '', [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
        beforeProviderStart: async () => {
          this.guard({ source: 'local', signal: controller.signal });
          if (!currentTurn() || blocked()) throw new Error('ORCA_STEER_BOUNDARY_CHANGED');
          await validate();
          this.guard({ source: 'local', signal: controller.signal });
          if (!currentTurn() || blocked()) throw new Error('ORCA_STEER_BOUNDARY_CHANGED');
          providerBoundaryReached = true;
        },
      });
      providerAccepted = true;
      removeWaiting();
      this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
      const visible = terminalOrcaHistoryMessage(message, receipt.collaboration);
      const agentMeta = { ...attribution, delivery: 'steer', autoReviewUserText: { kind: 'delegated-continuation' } };
      const stored = await this.storage.append(id, { kind: 'user', message: visible, clientId: item.clientId, origin: 'local', agentMeta });
      if (!await this.updateReceipt(id, item.clientId, 'completed')) throw new Error('SUBMISSION_PERSISTENCE_FAILED');
      this.emit('local-db:messages:created', { sessionId: id, message: { id: `${id}:${stored.sequence}`, clientId: item.clientId,
        sessionId: id, role: 'user', content: persistedInput(visible), createdAt: new Date(stored.timestamp).toISOString(),
        agentKind: session.agentKind === 'claude-code' ? 'cc' : session.agentKind, agentMeta } });
      return 'steered';
    } catch (error) {
      if (providerAccepted) {
        // Provider ACK cannot be undone by a later local bookkeeping failure.
        this.persistenceFaults.add(id);
        this.options.logger.warn('ORCA_STEER_PERSISTENCE_FAILED');
        return 'steered';
      }
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'ORCA_ASSIGNMENT_REVOKED') {
        removeWaiting();
        await this.updateReceipt(id, item.clientId, 'failed', reason);
        return 'rejected';
      }
      const knownUndelivered = /\[NO_ACTIVE_TURN\]|\[STALE_TURN\]|no active .*turn|has no active turn/i.test(reason);
      if (providerBoundaryReached && !knownUndelivered) {
        // An ACK timeout is not proof of non-delivery. Preserve the input in
        // a durable paused queue; only an explicit user resume may retry it.
        this.queuePaused.add(id);
        await this.storage.update(id, { queuePaused: true });
        await this.updateReceipt(id, item.clientId, 'queued', 'STEER_DELIVERY_UNCERTAIN');
        return 'queued';
      }
      await this.updateReceipt(id, item.clientId, 'queued');
      return 'not-attempted';
    } finally {
      if (this.steeringSubmissions.get(id) === boundary) this.steeringSubmissions.delete(id);
      void this.projection(id).then(value => this.emit('maker:input:projection', value)).catch(() => undefined);
      setImmediate(() => this.drain(id));
    }
  }
  private async steerQueuedOrcaInput(id: string, clientId: string): Promise<QueuedSteerOutcome> {
    const live = this.live.get(id)?.session;
    if (!live?.isTurnRunning()) return { kind: 'queued', reason: 'NO_ACTIVE_TURN' };
    if (!live.capabilities.sameTurnSteer.supported || live.remoteHostId) return { kind: 'queued', reason: 'STEER_UNSUPPORTED' };
    if (this.routes.isLocked(id)) return { kind: 'queued', reason: 'INPUT_BOUNDARY_BUSY' };
    const expected = { session: live, turnGeneration: live.getTurnGeneration() };
    return this.routes.withLock(id, async () => {
      const item = (await this.orcaQueue.snapshot(id)).find(row => row.clientId === clientId);
      if (!item) return { kind: 'gone' };
      const result = await this.steerOrcaInput(id, item, expected);
      if (result === 'steered') return { kind: 'steered' };
      if (result === 'rejected') return { kind: 'gone' };
      return { kind: 'queued', reason: result === 'queued' ? 'STEER_UNCERTAIN'
        : live.isTurnRunning() ? 'INPUT_BOUNDARY_BUSY' : 'NO_ACTIVE_TURN' };
    });
  }
  private emit(channel: string, payload: unknown) {
    if (this.closed) return;
    if (channel === 'local-db:messages:created') {
      const event = payload as { sessionId?: string; message?: { role?: string } };
      if (event?.sessionId && event.message?.role === 'user') this.orcaIpc?.history.notifyUserMessagePersisted(event.sessionId);
    }
    try { this.options.emit(channel, [payload]); }
    catch { this.options.logger.warn('Terminal subscriber delivery failed', { channel }); }
  }
  private view(row: TerminalTaskMeta) {
    const live = this.live.get(row.id);
    const { pendingHandoff: _handoff, goalContinuation: _goal, ...publicRow } = row;
    return { ...publicRow, sessionId: row.id, status: live?.session.getStatus() ?? 'idle', isTurnRunning: this.isTurnRunning(row.id), pendingInteractions: [...this.pending.values()].filter(p => p.sessionId === row.id && !p.migrated).map(p => p.request), ...(this.persistenceFaults.has(row.id) ? { persistenceError: true } : {}) };
  }
  private guiSession(row: TerminalTaskMeta) {
    return {
      ...this.view(row),
      userId: '', workingDir: row.workDir, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
      runtimeStatus: this.live.get(row.id)?.session.getStatus() ?? 'idle',
      agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind,
      sdkSessionId: row.sdkSessionId ?? null, providerId: row.providerId ?? null,
      agentSwitchIntent: this.routes.intent(row.id),
      planModeEnabled: row.planMode ?? false, fastMode: row.fastMode ?? false,
      pinnedAt: row.pinnedAt ? new Date(row.pinnedAt).toISOString() : null,
      parentSessionId: row.parentSessionId ?? null, remoteHostId: null, agentDeviceId: row.agentDeviceId ?? null,
      createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
      userSendAt: row.userSendAt ? new Date(row.userSendAt).toISOString() : null,
      ...(row.source === 'feishu' ? { feishuBotAppId: row.imBotContextId ?? null, feishuOpenId: row.imUserId ?? null } : {}),
      totalTokenUsage: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.tokenUsage ?? 0, totalCostUsd: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.costUsd ?? 0, contextTokens: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.contextTokens ?? 0, contextWindow: (this.live.get(row.id)?.session.getUsageSnapshot() ?? row.usage)?.contextWindow ?? 0,
      extraDirs: [], writableDirs: [],
    };
  }
  resolveManaged(url: string, sessionId?: string) { return this.media.resolveManaged(url, sessionId); }
  async configureProvider(action:'create'|'edit',provider:unknown,keys:unknown,context:InvocationContext) {
    await this.ready;
    this.guard(context);
    await this.models.saveProvider(provider,keys,action==='create',()=>this.guard(context));
    this.emit('maker:provider:changed',{});
    return {success:true};
  }
  registerCapabilityResources(registry:import('@cindy/device-link').RemoteResourceRegistry,configuration:import('../configuration.js').TerminalConfiguration) { registerCapabilityResources(registry,this.capabilities,configuration); registerUtilityModelResources(registry, this.utility); }
  /** Reuse media adoption for independently persisted companion transcripts.
   * The caller supplies its own profileDir to normalizeTaskInput, owns acceptance
   * callbacks, and does not create a regular task in this host. */
  attachmentHost(): Pick<InputHost, 'ingestAttachment' | 'resolveAttachment'> {
    return {
      ingestAttachment: this.options.ingestAttachment ?? ((input,context) => this.media.ingest(input, () => this.guard(context))),
      resolveAttachment: async (reference,context,sessionId) => {
        this.guard(context);
        if(reference.startsWith('cindy-media://')) return this.media.resolveManaged(reference, context.sharedTask ? sessionId : undefined);
        if(!this.options.resolveAttachment) throw new Error('ATTACHMENT_RESOLVER_REQUIRED');
        const value=await this.options.resolveAttachment(reference,context,sessionId);this.guard(context);return value;
      },
    };
  }
  resumePending(){this.pendingDispatchReady=true;for(const id of this.queuedSubmissions.keys())this.drain(id);}
  configurePluginSessions(hooks: TerminalPluginSessionHooks): TerminalPluginSessionPort {
    this.pluginSessions = hooks;
    const guard = () => this.guard({ source: 'local' });
    const execution = (id: string) => {
      const session = this.live.get(id)?.session;
      return session && (session.isTurnRunning() || session.getTurnControlSnapshot().pendingInteractionCount > 0)
        ? { instanceId: session.instanceId, generation: session.getTurnGeneration() } : null;
    };
    return {
      resolve: async route => {
        guard(); const { selection } = await this.selection({ ...route, ...(route.agentKind ? {agentKind:route.agentKind==='cc'?'claude-code':route.agentKind}: {}) }); guard();
        return { agentKind: selection.agentKind==='claude-code'?'cc':selection.agentKind, providerId:selection.providerId, model:selection.model, effort:selection.effort??'', fastMode:route.fastMode??false };
      },
      create: async (input, current, onPersistenceStarted) => {
        const check=()=>{guard();current();}; check();
        await this.create({title:input.title,...input.route,agentKind:input.route.agentKind==='cc'?'claude-code':input.route.agentKind,permissionMode:input.permissionMode,...(input.workingDir?{workingDir:input.workingDir}:{})}, check, {id:input.id,hidden:input.hidden,onPersistenceStarted});
      },
      read: async id => {
        const row=await this.storage.get(id); guard();
        if(!row || row.source!=='plugin' || row.agentDeviceId)return null;
        const pending=this.routes.intent(id);if(pending?.agentDeviceId)return null;
        const kind=pending?.targetAgentKind??row.agentKind;
        const resolvedConfig={agentKind:kind==='claude-code'?'cc' as const:kind,providerId:pending?.providerId??row.providerId??'',model:pending?.model??row.model,effort:pending?.effort??row.effort??'',fastMode:pending?.fastMode??row.fastMode??false};
        const status=row.deleted?'deleted' as const:row.archived?'archived' as const:'active' as const;
        const revision=Number.parseInt(createHash('sha256').update(JSON.stringify([resolvedConfig,row.permissionMode,row.planMode,row.workDir,status,row.clearedAt])).digest('hex').slice(0,12),16);
        return {taskId:id,title:row.title??'',status,revision,resolvedConfig,workingDir:row.workDir,permissionMode:row.permissionMode,planModeEnabled:row.planMode===true,hidden:row.hiddenAt!=null};
      },
      setModel: async(id,route,current)=>{
        guard();await current();
        const result=await this.routes.select({sessionId:id,targetAgentKind:route.agentKind==='cc'?'claude-code':route.agentKind,model:route.model,providerId:route.providerId,effort:route.effort,fastMode:route.fastMode,beforeMutation:current,assertSelectionCurrent:guard});
        guard();return {status:result.deferred?'deferred':'applied'};
      },
      live: id=>{guard();return this.live.get(id)?.session;},
      inspect: async id=>{const pending=await this.storage.queued(id);guard();return {execution:execution(id),pending:pending.map(row=>({clientId:row.requestId}))};},
      dispatch: async (plugin,id,clientId,text,images,current)=>{
        const check=()=>{guard();current();};check();
        const attachments=[];
        for(const image of images){const media=await this.media.ingest({sessionId:id,bytes:image.buffer,mimeType:image.mimeType,name:image.name},check);check();attachments.push({type:'image' as const,path:media.path,mimeType:image.mimeType,name:image.name});}
        const receipt=await this.submit(id,{text,...(attachments.length?{files:attachments}:{})},{requestId:clientId},{source:'local',plugin,assertCurrent:check});
        check();return {ok:!['failed','interrupted'].includes(receipt.status)};
      },
      cancel: async (id,clientIds,expected,current)=>{
        const check=()=>{guard();current();};check();
        for(const receipt of await this.storage.queued(id))if(clientIds.includes(receipt.requestId))await this.removeQueued(id,receipt.requestId,{source:'local',assertCurrent:check});
        if(!expected)return 'cancelled';
        return this.routes.withLock(id,async()=>{check();if(!isSameSessionExecution(execution(id),expected))return 'stale' as const;await this.invoke('maker:input:stop',[id],{source:'local',assertCurrent:check});check();return 'stopping' as const;});
      },
      hidden: async(id,value,current)=>{guard();current();const row=await this.storage.update(id,{hiddenAt:value?Date.now():null});guard();current();this.emit('terminal:tasks:changed',{sessionId:id});this.emit('local-db:sessions:patched',{sessionId:id,patch:this.guiSession(row)});},
      history: async id=>{const rows=await this.contextMessages(id,Infinity);guard();return rows.map(row=>({...row,agentMeta:row.agentMeta??null}));},
      withTaskLock: (id,run)=>this.routes.withLock(id,run),
      withPermissionLock: (id,run)=>this.permissionChanges.withSessionPermissionChange(id,run),
      assertIdle: async(id,unstarted,current)=>{
        const check=()=>{guard();current();};check();await this.ready;check();
        if(unstarted){
          const row=await this.storage.get(id);check();
          if(!row)throw new PluginTaskError('TASK_NOT_FOUND','Task not found');
          if(row.userSendAt!=null)throw new PluginTaskError('TASK_BUSY','Only an unstarted task can request write access');
          let cursor=0;
          for(;;){
            const page=await this.storage.history(id,cursor,1000);check();
            // Clearing or rebuilding the visible conversation never renews a grant.
            if(page.records.some(record=>record.kind==='user'))throw new PluginTaskError('TASK_BUSY','Only an unstarted task can request write access');
            if(!page.hasMore)break;cursor=page.nextCursor;
          }
        }
        const pending=await this.storage.queued(id);check();
        if(pending.length||this.isTurnRunning(id)||this.starts.has(id)||this.sending.has(id)||[...this.pending.values()].some(value=>value.sessionId===id))throw new PluginTaskError('TASK_BUSY','Wait for the current turn before changing permission');
      },
      confirmPermission: async(id,input,current,signal)=>{
        const task=await this.ensureLive(id);guard();current();
        // This is an owner setting, not permission to resume a paused turn.
        // It uses the same authenticated pending UI without releasing the queue.
        const result=await this.interaction(id,{kind:'permission',requestId:randomUUID(),toolName:'cindy.plugin.task.writeAccess',title:input.title,description:`${input.message}\n\n${input.detail}`,input:{}},signal,undefined,true);
        guard();current();
        return this.live.get(id)===task&&result.kind==='permission'&&result.behavior==='allow';
      },
      changePermission: async(id,mode,current,persistPreferences)=>{
        guard();current();
        const row=await this.storage.get(id);guard();current();
        if(!row)throw new PluginTaskError('TASK_NOT_FOUND','Task not found');
        const previous=permission(row.permissionMode==='default'?'ask':row.permissionMode??'ask'),live=this.live.get(id)?.session;
        let touched=false;
        try{
          if(live)await live.setPermissionMode(mode);guard();current();
          touched=true;await this.storage.update(id,{permissionMode:mode});guard();current();
          await persistPreferences();guard();current();
        }catch(error){
          if(live)await live.setPermissionMode(previous).catch(()=>this.options.logger.warn('PLUGIN_PERMISSION_ROLLBACK_FAILED'));
          if(touched)await this.storage.update(id,{permissionMode:previous}).catch(()=>this.options.logger.warn('PLUGIN_PERMISSION_PERSIST_ROLLBACK_FAILED'));
          throw error;
        }
        this.emit('terminal:tasks:changed',{sessionId:id});
        this.emit('local-db:sessions:patched',{sessionId:id,patch:{permissionMode:mode}});
      },
    };
  }
  configurePlugins(factory:(context:PluginTaskContext)=>Promise<TerminalPluginTask>,setup:TerminalPluginSetup){this.pluginFactory=factory;this.pluginSetup=setup;}
  requestHostPermission:import('@cindy/plugin-runtime/ghostInstallConsentInteraction').HostPermissionRequester=async(id,instance,request,signal)=>{
    const task=this.live.get(id);if(this.closed||!task||task.session.instanceId!==instance)return null;
    const result=await requestHostInteraction(task.session,request,signal??new AbortController().signal);return this.live.get(id)===task?result:null;
  };
  async beginChannelInteraction(id:string,registration:Parameters<typeof beginInteractionRoute>[1]){
    const task=await this.ensureLive(id);
    return beginInteractionRoute(task.session,registration);
  }
  /** Trusted channel adapters use the same running tasks as GUI/TUI clients.
   * The channel repository must commit the task before attaching its runtime. */
  channelRuntime(): ReturnType<ImTurnHost['getMaker']> {
    return this.channelMaker ??= {
      on: listener => { this.guard({source:'local'}); this.makerObservers.add(listener); return () => { this.makerObservers.delete(listener); }; },
      getSession: id => {
        if (this.closed) return undefined;
        const session = this.live.get(id)?.session;
        return session?.getStatus() === 'active' ? session : undefined;
      },
      getCapabilities: kind => {
        const capabilities = this.engineCapabilities.get(kind);
        if (!capabilities) throw new Error('TASK_HOST_NOT_READY');
        return capabilities;
      },
      getAgentAuthState: async kind => { await this.ready; this.guard({source:'local'}); return this.authState(kind); },
      createSession: async input => {
        await this.ready; this.guard({source:'local'});
        if (!input.id) throw new Error('CHANNEL_TASK_ID_REQUIRED');
        const row = await this.storage.get(input.id);
        if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
        this.guard({source:'local'});
        const hydrated = this.channelHydration.get(input.id);
        this.channelHydration.delete(input.id);
        // The committed task is authoritative. A stale channel attachment may
        // not overwrite a model selection changed by GUI while it was loading.
        if (hydrated && (hydrated.providerId !== undefined && hydrated.providerId !== (row.providerId ?? null)
          || hydrated.effort !== undefined && hydrated.effort !== (row.effort ?? 'high')
          || hydrated.fastMode !== undefined && hydrated.fastMode !== (row.fastMode ?? false))) throw new Error('CHANNEL_TASK_ROUTE_CHANGED');
        if (this.live.get(input.id)?.session.getStatus() !== 'active' && input.vendorOptions) this.channelVendorOptions.set(input.id, input.vendorOptions);
        return (await this.ensureLive(input.id)).session;
      },
    };
  }
  private async contextMessages(id: string, limit: number): Promise<Array<import('@cindy/im-runtime/planReconcile').PlanReconcileCandidateRow & { rowid: number }>> {
    const rows = await this.messages(id, { limit }, true);
    return rows.reverse().map(row => {
      let content: unknown = row.content;
      if (row.role === 'tool_use' || row.role === 'agent_switch') { try { content = JSON.parse(row.content); } catch { /* historical plain text */ } }
      return { clientId: row.clientId, rowid: row.rowid!, role: row.role, content, createdAt: Date.parse(row.createdAt), agentMeta: row.agentMeta };
    });
  }
  private async replayRecoveredTask(...[id, content, wireContent, recovery]: Parameters<ContextOverflowRolloverDeps['replayUserMessage']>): Promise<{ accepted: boolean }> {
    this.guard({ source: 'local', signal: recovery?.signal });
    const row = await this.storage.get(id);
    if (!row || row.deleted || row.archived || this.channelBindings.store.findByTarget(id) || this.pluginSetup?.surface.isHeadlessGhostSetupTurn(id)) return { accepted: false };
    const projection = createAutoReviewIntentProjection();
    const history = await this.contextMessages(id, Infinity);
    const source = recovery?.continueFromHistory ? recovery.sourceUserContent : content;
    const wire = persistedUserContentToWireMessage(wireContent ?? content);
    const outgoing = await this.taskContext.prepareHandoff(id, typeof wire === 'string' ? { type: 'user', content: wire } : wire as UserMessage);
    const task = await this.ensureLive(id);
    const result = await task.session.send(outgoing.message, {
      signal: recovery?.signal,
      [AUTO_REVIEW_SOURCE_CONTENT]: projection.readText(source) ?? '',
      [AUTO_REVIEW_USER_INTENT]: projection.restore(history.map(message => ({ ...message, agentMeta: message.agentMeta ?? null }))),
      ...(recovery?.continueFromHistory ? { [INHERITED_CAPABILITY_SELECTION]: recovery.sourceCapabilitySelectionText,
        [PI_CACHE_RECOVERY_EXPECTATION]: recovery.piCacheCompatibility, ...(recovery.piCacheCompatibility ? { retryUserClientId: recovery.sourceUserClientId } : {}) } : {}),
      onAccepted: () => { this.guard({ source: 'local', signal: recovery?.signal }); this.turnLifecycle.noteUserSend(id); },
    });
    if (result.accepted) outgoing.accepted();
    return { accepted: result.accepted };
  }
  channelTurnHost(): ImTurnHost {
    const guard = () => this.guard({ source: 'local' });
    const hydrate = (id: string, patch: NonNullable<ReturnType<typeof this.channelHydration.get>>) => {
      guard(); this.channelHydration.set(id, { ...this.channelHydration.get(id), ...patch });
    };
    const update = async (id: string, patch: Partial<TerminalTaskMeta>) => {
      guard();
      const row = await this.storage.updateIf(id, current => !current.deleted, patch, guard);
      guard();
      if (!row) throw new Error('TASK_NOT_FOUND');
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    };
    return this.channelHost ??= {
      getMaker: () => this.channelRuntime(),
      createLogger: scope => this.options.logger.child(scope),
      readSession: async id => {
        await this.ready; guard();
        const row = await this.storage.get(id); guard();
        return row ? { id: row.id, agentKind: row.agentKind, workingDir: row.workDir, title: row.title, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', orcaRole: row.orcaRole ?? null,
          model: row.model, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, remoteHostId: null,
          sdkSessionId: row.sdkSessionId ?? null, effort: row.effort ?? 'high', fastMode: row.fastMode ?? false,
          permissionMode: permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask'), workspaceKind: row.workspaceKind ?? 'project' } : null;
      },
      persistSdkSessionId: (id, value) => update(id, { sdkSessionId: value }),
      listProviders: () => this.models.views(),
      readImRemoteProviderRoute: route => readRemoteProviderRoute(route, async (device, channel, args) => {
        guard(); if (!this.options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const result = await this.options.remoteInvoke(device, channel, args); guard(); return result;
      }),
      readXdGatewayApiKey: async () => { guard(); const key = await this.models.credential('xd', 'claude-code'); guard(); return key; },
      hasCustomProviderKey: async (provider, kind) => { guard(); const key = await this.models.credential(provider, kind); guard(); return Boolean(key); },
      isCredentialModeSwitchBusyError,
      hydrateSessionProvider: (id, providerId) => hydrate(id, { providerId }),
      setSessionEffort: (id, effort) => hydrate(id, { effort }),
      setSessionFastMode: (id, fastMode) => hydrate(id, { fastMode }),
      wireSessionToIpcExternal: session => { guard(); if (this.live.get(session.id)?.session !== session) throw new Error('TASK_RUNTIME_REPLACED'); },
      repoTouchUserSent: id => update(id, { userSendAt: Date.now() }),
      readPermissionMode: async id => { guard(); const row = await this.storage.get(id); guard(); return row && !row.deleted ? permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask') : null; },
      updatePermissionMode: (id, mode) => update(id, { permissionMode: mode }),
      bindingStore: this.channelBindings.store,
      persistUserMessage: args => this.persistChannelMessage(args),
      adoptStagedInboundFiles: (...args) => this.channelFiles.adoptStagedInboundFiles(...args),
      beginTurnChangeSetAtDispatch: (session, anchor) => this.changes.begin(session, anchor),
      clearPendingTurnChangeSets: id => this.changes.store.clearPendingTurnChangeSets(id),
      takePendingInteractionsForSession: id => this.takeChannelInteractions(id),
      noteSilentStopUserSend: id => this.turnLifecycle.noteUserSend(id),
      stopSessionTurnExplicitly: async id => { guard(); const session = this.live.get(id)?.session; if (session) await this.turnLifecycle.stop(session); },
      onSilentStopSettled: (id, callback) => this.turnLifecycle.onSettled(id, callback),
      agentHandoffPending: this.taskContext.handoff,
      enqueueDurableWrite: (label, write) => this.taskContext.enqueue(label, write),
      listMessagesForAgentHandoff: (id, limit) => this.contextMessages(id, limit),
      peekGoalInactiveNote: id => this.taskContext.peekGoalInactiveNote(id),
      isSilencedSchedulerTurn: origin => origin?.kind === 'scheduler' && Boolean(origin.runId) && this.schedulerDeps?.getScheduler().isRunSilenced(origin.runId!) === true,
      beginHeadlessGhostSetupTurn: id => {
        guard(); return (this.pluginSetup?.surface ?? this.channelPluginSurface).beginHeadlessGhostSetupTurn(id);
      },
      bindRuntimeRecoveryNotice: (...args) => this.channelRecovery.bindRuntimeRecoveryNotice(...args),
      redactToolInputForUntrustedBoundary,
      generateAndPersistFbotTitle: async (id, text, prefix) => {
        const generated = await this.generateTaskTitle({ sessionId: id, message: text });
        if (!generated) return null;
        const title = fbotTitle(generated, prefix); await update(id, { title }); return title;
      },
      generateImSessionTitleText: (id, text) => this.generateTaskTitle({ sessionId: id, message: text }),
      persistGeneratedSessionTitle: (id, title) => update(id, { title }),
      resolveSessionErrorContext: async id => {
        guard(); const row = await this.storage.get(id); if (!row || row.deleted) return {};
        const providers = row.agentDeviceId && this.options.remoteInvoke ? await readDeviceProviderViews(this.options.remoteInvoke, row.agentDeviceId) : await this.models.views();
        guard(); const provider = providers.find(provider => provider.id === row.providerId);
        return { taskLabel: row.title, providerLabel: provider?.name, modelLabel: provider?.models[row.agentKind]?.find(model => model.id === row.model)?.name ?? row.model };
      },
      resolveCindyMediaUrl: url => this.media.resolveMediaUrl(url),
      resolveXdtImageUrl: url => this.media.resolveLegacyImageUrl(url),
      materializeLocalMarkdownImages: args => this.materializeChannelImages(args),
      changeSessionPermissionMode: args => this.changeChannelPermission(args),
    };
  }
  channelTurnDependencies(channel?: TerminalChannelRouteConfig): import('@cindy/im-runtime/turnRunner').ImTurnRunnerDeps {
    const follower = channel && createTerminalChannelRouteFollower(channel, {
      storage: this.storage, routes: this.routes, defaults: this.channelSessionDefaults,
      listProviders: () => this.models.views(), assertCurrent: () => this.guard({ source: 'local' }), logger: this.options.logger,
    });
    return { acquirePendingAgentSwitch: (id, options) => this.routes.acquireForSend(id, options?.channelOwned && follower ? () => follower.syncUnderLock(id) : undefined),
      ...(follower ? { channelDefaultRoute: follower } : {}),
      prepareUnhealthySession: async id => { await this.routes.withLock(id, () => this.routes.recovery.runtime.prepareUnhealthySession(id)); },
    };
  }
  channelCardHost(): ImCardHost {
    const guard = () => this.guard({ source: 'local' });
    const update = async (id: string, patch: Partial<TerminalTaskMeta>) => {
      guard();
      const row = await this.storage.updateIf(id, current => !current.deleted && !current.archived, patch, guard);
      if (!row) throw new Error('TASK_NOT_FOUND');
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    };
    const turns = this.channelTurnHost();
    return this.channelCards ??= {
      ...this.channelControl.commands, ...this.channelControl.account,
      createLogger: scope => this.options.logger.child(scope),
      bindingStore: this.channelBindings.store,
      getMaker: () => ({
        getSessionMeta: async id => { guard(); return this.storage.get(id); },
        getCapabilities: kind => this.channelRuntime().getCapabilities(kind),
        createSession: async input => {
          guard();
          const id = input.id && await this.storage.get(input.id) ? input.id : (await this.create({ ...input }, guard)).id;
          return (await this.ensureLive(id)).session;
        },
        closeSession: async id => { guard(); await this.closeTask(id); },
      }),
      normalizeSessionProviderId: value => value === undefined ? undefined : value?.trim() || null,
      setSessionProvider: (id, provider) => this.routes.hydrateProvider(id, provider),
      withSendToSessionLock: (id, action) => this.routes.withLock(id, action),
      selectModelUnderLock: async (id, model, provider, effort) => { await this.routes.selectModelUnderLock(id, model, provider, { effort }, undefined, guard); },
      cancelPendingAgentSwitchForSession: id => this.routes.cancel(id),
      getTaskDefaults: () => {
        guard(); const selection = this.models.snapshot().defaultSelection;
        return selection?.agentKind === 'claude-code' ? { ...selection, effort: selection.effort ?? 'high', permissionMode: 'ask', fastMode: false } : null;
      },
      resolveNewTaskDefaultModelRoute: async kind => {
        await this.ready; guard();
        const saved = this.models.snapshot().defaultSelection;
        try { const route = await this.selection(saved?.agentKind === kind ? { ...saved } : { agentKind: kind }); guard(); return route.selection; }
        catch { guard(); return null; }
      },
      resolveLenientSessionRoute: async (kind, model, providerId, options) => {
        guard(); const views = await this.models.views(); guard();
        const route: Awaited<ReturnType<ImCardHost['resolveLenientSessionRoute']>> = resolveLenientRoute(views, kind, model, providerId, options);
        if (options.desiredFastMode && route.model && (route.model !== model || route.providerId !== providerId)) {
          const provider = route.providerId ? views.find(row => row.id === route.providerId) : sourcesForModel(views, route.model, kind)[0];
          route.fastMode = provider && modelSupportsFastMode(provider, route.model, kind)
            && (options.desiredFastMode !== 'ultrafast' || kind === 'codex' && provider.models.codex?.some(row => row.id === route.model && row.supportsUltrafastMode)) ? options.desiredFastMode : false;
        }
        return route;
      },
      listSessionsForWorkspace: this.channelControl.projects.listSessionsForWorkspace,
      exitControl: (...args) => { guard(); this.channelControl.state.exitControl(...args); },
      generateTakeoverSummary: async id => {
        guard(); const rows = await this.messages(id, { limit: Infinity }); guard();
        return rows.find(row => row.role === 'assistant' && row.content.trim())?.content ?? null;
      },
      broadcastSessionCreated: id => { guard(); this.emit('local-db:sessions:created', { sessionId: id }); },
      readImDefaultSettings: channel => this.channelDefaults.read(channel),
      readModelRouteSnapshot: async id => {
        guard(); const row = await this.storage.get(id); guard();
        return row ? { model: row.model, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, effort: row.effort ?? 'high' } : null;
      },
      switchSessionWorkingDir: (id, directory, workspaceKind) => this.routes.withLock(id, async () => {
        guard();
        if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
        await this.closeTask(id);
        await update(id, { workDir: directory, workspaceKind, sdkSessionId: undefined, clearedAt: Date.now(), pendingHandoff: undefined });
        this.taskContext.refresh(id);
        this.emit('local-db:sessions:created', { sessionId: id });
      }),
      touchUserSent: id => turns.repoTouchUserSent(id),
      updateModelEffort: async (id, model, effort, provider) => {
        guard(); const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
        const resolved = await this.selection({ ...row, model, effort, providerId: provider === undefined ? row.providerId : provider });
        await update(id, resolved.selection);
      },
      markImSessionManualRouteOverride: async id => { await this.routes.deps.onUserRouteSelectionLanded?.(id); },
      readImRemoteProviderRoute: turns.readImRemoteProviderRoute,
      readPermissionMode: turns.readPermissionMode, updatePermissionMode: turns.updatePermissionMode,
      changeSessionPermissionMode: turns.changeSessionPermissionMode,
      lookupPending, resolvePending,
    };
  }
  resetChannelTask: ImCommandHost['resetImSessionToChannelDefaults'] = async (id, config, prepared, channel) => {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    await this.routes.withLock(id, async () => {
      const row = await this.storage.get(id);
      if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
      const defaults = prepared ?? await this.channelSessionDefaults.resolveImSessionDefaults(config, undefined, channel);
      const directory = channel === 'wechat' && prepared?.workingDir ? prepared.workingDir : row.workDir;
      const { input, resolved, cwd } = await this.admitTask({ ...defaults, workingDir: directory }, id, guard);
      await this.closeTask(id);
      guard();
      const fingerprint = prepared?.defaultRouteFingerprint ?? ('fingerprint' in defaults ? defaults.fingerprint : this.channelSessionDefaults.readImDefaultSettingsFingerprint(channel));
      const patch: Partial<TerminalTaskMeta> = {
        ...resolved.selection, workDir: cwd, permissionMode: permission(defaults.permissionMode), fastMode: defaults.fastMode,
        agentDeviceId: input.agentDeviceId ? string(input.agentDeviceId) : undefined,
        groupBinding: input.groupBinding as TerminalTaskMeta['groupBinding'],
        sdkSessionId: undefined, clearedAt: Date.now(), pendingHandoff: undefined,
        ...(row.usage ? { usage: { ...row.usage, contextTokens: 0, contextWindow: resolved.route.model.contextWindow ?? 0 } } : {}),
        imDefaultRoute: buildImDefaultRouteRecord(fingerprint, { ...resolved.selection, agentDeviceId: input.agentDeviceId ? string(input.agentDeviceId) : null, effort: resolved.selection.effort ?? null }),
      };
      const updated = await this.storage.updateIf(id, current => !current.deleted && !current.archived, patch, guard);
      if (!updated) throw new Error('TASK_NOT_FOUND');
      this.routes.cancel(id);
      this.taskContext.refresh(id);
      this.channelHydration.delete(id);
      if (updated.groupBinding) this.groupBindings.set(id, updated.groupBinding); else this.groupBindings.delete(id);
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(updated) });
    });
  };
  async persistChannelMessage(args: Parameters<ImTurnHost['persistUserMessage']>[0]): ReturnType<ImTurnHost['persistUserMessage']> {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    const clientId = args.existingClientId ?? randomUUID();
    try {
      guard();
      const row = await this.storage.get(args.sessionId);
      if (!row || row.deleted) return null;
      if (args.existingClientId) {
        const patched = await this.storage.patchUserMeta(args.sessionId, clientId, args.source ? { imSource: args.source } : {}, guard);
        if (!patched) return null;
      } else {
        const message = await this.message(args.sessionId, { text: args.text, files: (args.attachments ?? []).map(item => ({ type: item.kind, path: item.absPath, name: item.originalName, mimeType: item.mimeType })) }, { source: 'local' });
        guard();
        await this.storage.append(args.sessionId, { kind: 'user', message, clientId, ...(args.source ? { agentMeta: { imSource: args.source } } : {}) });
      }
      guard();
      const message = (await this.messages(args.sessionId, { limit: Infinity }, true)).find(row => row.clientId === clientId);
      guard();
      if (message) this.emit('local-db:messages:created', { sessionId: args.sessionId, message });
      return message ? { clientId } : null;
    } catch {
      if (this.closed) return null;
      this.options.logger.warn('Channel message could not be saved');
      return args.existingClientId ? { clientId } : null;
    }
  }
  async materializeChannelImages(args: Parameters<ImTurnHost['materializeLocalMarkdownImages']>[0]): ReturnType<ImTurnHost['materializeLocalMarkdownImages']> {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    guard();
    const row = await this.storage.get(args.sessionId);
    if (!row || row.deleted) throw new Error('TASK_NOT_FOUND');
    const assertTaskCurrent = async () => {
      guard();
      const current = await this.storage.get(row.id);
      if (!current || current.deleted || current.workDir !== row.workDir || current.clearedAt !== row.clearedAt || current.sdkSessionId !== row.sdkSessionId || current.agentKind !== row.agentKind) throw new Error('TASK_IMAGE_SCOPE_CHANGED');
      guard();
    };
    const scope = { id: row.id, workingDir: row.workDir, sdkSessionId: row.sdkSessionId ?? null, agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind, remoteHostId: null, status: row.archived ? 'archived' : 'active', clearedAt: row.clearedAt ?? null };
    const result = await this.media.channelImages({ ...args, workingDir: row.workDir }, (id, text) => {
      if (id !== row.id) throw new Error('TASK_SCOPE_MISMATCH');
      return this.media.materializeTaskImages(scope, text, guard, assertTaskCurrent);
    });
    await assertTaskCurrent();
    return result;
  }
  changeChannelPermission(args: Parameters<ImTurnHost['changeSessionPermissionMode']>[0]) {
    return changeSessionPermissionMode(args, {
      captureAccount: () => ({ assertCurrent: () => this.guard({ source: 'local' }), isCurrent: () => !this.closed }),
      withSessionPermissionChange: (id, operation) => this.permissionChanges.withSessionPermissionChange(id, operation),
    });
  }
  private async nativeUtilityText(kind: AgentKind, prompt: string, opts: Parameters<UtilityNativeAgents['oneShot']>[2]) {
    await this.ready; this.guard({ source: 'local' });
    if (kind !== 'codex') throw new Error('UTILITY_NATIVE_ROUTE_UNAVAILABLE');
    const id = `utility-${randomUUID()}`;
    const chosen = await this.models.select({ agentKind: kind, providerId: kind === 'codex' ? 'openai' : 'anthropic', model: opts?.model });
    const revision = this.models.revision();
    const current = async () => !this.closed && revision === this.models.revision() && !this.models.isMutating() && (!opts?.beforeDispatch || await opts.beforeDispatch());
    const binary = this.binaries.get(kind);
    if (!binary || !await current()) throw new Error('UTILITY_NATIVE_ROUTE_UNAVAILABLE');
    const agent = await (this.options.createAgent ?? createTerminalAgent)({ profileDir: this.options.profileDir, taskId: id, ...chosen, binaryPath: binary, models: this.models, logger: this.options.logger });
    try {
      if (!await current()) throw new Error('UTILITY_ROUTE_CHANGED');
      return await agent.oneShot(prompt, { ...opts, beforeDispatch: current });
    } finally {
      await agent.dispose();
      await rm(path.join(this.options.profileDir, 'engines', 'codex', id), { recursive: true, force: true });
    }
  }
  private permissionReviewer(guard:()=>void,prepare:(request:AutoReviewRequest)=>Promise<AutoReviewRequest>,signal?:AbortSignal):AutoReviewDelegate {
    const review:AutoReviewDelegate=request=>this.utility.reviewPermission(request,guard,signal);
    review.prepareRequest=async request=>{
      guard();const prepared=await prepare(request);guard();return prepared;
    };
    return review;
  }
  requestChannelUtilityText(_channel: import('@cindy/im-runtime/imDefaultSettings').ImDefaultSettingsChannel, prompt: string, opts: import('@cindy/model-providers/utilityTextRequest').UtilityTextRequestOptions) {
    return this.utility.request(prompt, opts);
  }

  generateTaskTitle(input: { message: string; sessionId?: string; agentKind?: AgentKind }): Promise<string | null> {
    const operation = this.runTaskTitle(input);
    this.utilityWork.add(operation);
    void operation.finally(() => this.utilityWork.delete(operation)).catch(() => {});
    return operation;
  }
  private async runTaskTitle(input: { message: string; sessionId?: string; agentKind?: AgentKind }): Promise<string | null> {
    try {
      await this.ready; this.guard({ source: 'local' });
      if (!input.message.trim()) return null;
      const row = input.sessionId ? await this.storage.get(input.sessionId) : null;
      if (input.sessionId && (!row || row.deleted)) return null;
      const revision = this.models.revision();
      const current = async () => {
        if (this.closed || revision !== this.models.revision()) return false;
        if (!row) return true;
        const latest = await this.storage.get(row.id);
        return !this.closed && Boolean(latest && !latest.deleted && latest.agentKind === row.agentKind && latest.providerId === row.providerId && latest.model === row.model && latest.agentDeviceId === row.agentDeviceId && latest.clearedAt === row.clearedAt);
      };
      if (row?.agentDeviceId) {
        if (!this.options.remoteInvoke) return null;
        const response = await this.options.remoteInvoke(row.agentDeviceId, 'maker:generate-title', [{ message: input.message.slice(0, 200), agentKind: row.agentKind }]);
        return response.ok && await current() ? validateTitleOutput((response.result as { title?: string } | undefined)?.title, AUTO_TITLE_MAX_CHARS) : null;
      }
      const output = await this.utility.request(buildAutoTitlePrompt(input.message.trim().slice(0, 200), this.options.language?.() ?? 'en'), {
        maxTokens: AUTO_TITLE_MAX_CHARS * 4, timeoutMs: 12_000,
        signal: this.utilityAbort.signal, beforeDispatch: current,
        validateResponse: value => Boolean(validateTitleOutput(value, 256)),
        responseInstructions: 'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.',
      });
      if (!output.ok) return null;
      if (!await current()) return null;
      const title = validateTitleOutput(output.text, 256);
      return title ? Array.from(title).slice(0, AUTO_TITLE_MAX_CHARS).join('') : null;
    } catch { return null; }
  }
  configureKnowledge(knowledge?: Pick<TerminalKnowledge, 'createRuntime' | 'snapshot'>) { this.knowledge = knowledge; }
  configureChannelTools(factory: NonNullable<TerminalTaskHost['channelTools']>) { this.channelTools = factory; }
  async pluginPermissionSnapshot(id:string,instanceId?:string):Promise<(import('@cindy/plugin-runtime/fsSlot').FsSessionSnapshot & {autoReviewOwner:'native'|'cindy'})|null>{
    const task=this.live.get(id);if(this.closed||!task||instanceId&&task.session.instanceId!==instanceId)return null;
    const session=task.session,permission=session.stablePermissionModeState,plan=session.stablePlanModeState;
    if(!permission?.mode||!plan)return null;
    const row=await this.storage.get(id);if(!row||this.live.get(id)!==task)return null;
    const isCurrent=()=>!this.closed&&this.live.get(id)===task&&session.stablePermissionModeState?.generation===permission.generation&&session.stablePlanModeState?.generation===plan.generation;
    if(!isCurrent())return null;
    return {workingDir:row.workDir,permissionMode:permission.mode,planModeEnabled:plan.enabled,remoteHostId:null,autoReviewOwner:session.autoReviewOwner,isCurrent,reviewAction:action=>session.reviewHostPermissionAction(action)};
  }
  async requestPluginWrite(id:string,payload:import('@cindy/plugin-runtime/grantTypes').GhostGrantConfirmPayload,signal?:AbortSignal):Promise<import('@cindy/plugin-runtime/grantTypes').GhostGrantConfirmDecision>{
    const task=this.live.get(id);if(!task||this.closed)return {confirmed:false,reason:'session_closed'};
    const decision=await requestHostInteraction(task.session,{kind:'permission',requestId:randomUUID(),toolName:'cindy.plugin.write',input:payload as unknown as Record<string,unknown>},signal??new AbortController().signal);
    return decision.kind==='permission'&&decision.behavior==='allow'&&this.live.get(id)===task?{confirmed:true}:{confirmed:false,reason:'cancelled'};
  }
  configureScheduler(deps?: import('../../../../packages/lizi-mcps/src/types.js').SchedulerMcpDeps) {this.schedulerDeps=deps;}
  helperDeps(input:{sessionId:string;workingDir:string;agentKind:AgentKind;setTitle?:(title:string)=>Promise<void>;title?:()=>string}):import('../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js').XdtHelperMcpDeps {
    return {
      history:this.historyDeps(),
      runtimeCapabilities:async()=>({terminal:true,tasks:true,nativeAgent:input.agentKind,available:['tasks','history','approvals','models',...(this.schedulerDeps?['scheduler']:[]),...(this.knowledge?.snapshot().memory?['memory']:[]),...(this.knowledge?.snapshot().contacts?['contacts']:[])],unavailable:[...(!this.knowledge?.snapshot().contacts?['contacts']:[]),'browser','media-generation']}),
      setCurrentSessionTitle:async({sessionId,title})=>{if(sessionId!==input.sessionId)throw new Error('TASK_SCOPE_MISMATCH');if(input.setTitle)await input.setTitle(title);else await this.patchMeta(sessionId,{title});return {ok:true,sessionId,title};},
      sendToSession:async params=>{
        if(params.useWorktree)return {ok:false,errorCode:'WORKTREE_UNAVAILABLE',message:'Worktree creation is not configured'};
        let id=params.targetSessionId;const existing=id?await this.storage.get(id):null;
        if(id&&!existing)return {ok:false,errorCode:'NOT_FOUND',message:'Task not found'};
        if(existing?.deleted)return {ok:false,errorCode:'DELETED',message:'Task is deleted'};
        if(existing?.archived)return {ok:false,errorCode:'ARCHIVED',message:'Task is archived'};
        if(!id){const created=await this.create({workingDir:params.workingDir??input.workingDir,title:params.title,...(params.agentKind?{agentKind:params.agentKind}:{}),...(params.model?{model:params.model}:{}),...(params.effort?{effort:params.effort}:{})},()=>this.guard({source:'local'}));id=created.id;}
        const target=await this.storage.get(id);if(!target)throw new Error('TASK_NOT_FOUND');
        const receipt=await this.submit(id,{text:params.message},{},{source:'local',sender:{sessionId:input.sessionId,title:input.title?.()}});
        return {ok:true,targetSessionId:id,agentKind:target.agentKind,wakeKind:existing?'queued':'created',targetTitle:target.title,targetLastUserSendAt:null,queuedMessageId:receipt.requestId,providerId:target.providerId??null,model:target.model};
      },
      sessionQueue:{
        listSessionQueue:async id=>{if(!await this.storage.get(id))return {ok:false,errorCode:'NOT_FOUND',message:'Task not found'};const rows=await this.storage.queued(id);return {ok:true,messages:rows.map((row,index)=>({queuedMessageId:row.requestId,position:index,source:row.scheduler?'scheduler':row.sender?'session':'user',sourceLabel:row.scheduler?.scheduleName??row.sender?.title??null,enqueuedAtMs:row.createdAt,content:inputPlainText(row.message),consuming:false}))};},
        listSessionQueuedCounts:async ids=>({ok:true,counts:Object.fromEntries(await Promise.all(ids.map(async id=>[id,(await this.storage.queued(id)).length])))})
      }
    };
  }
  createToolsForCompanion(input:{sessionId:string;workingDir:string;agentKind:AgentKind;setTitle?:(title:string)=>Promise<void>;title?:()=>string;extraFactories?:Parameters<typeof createTaskTools>[0]['extraFactories']}) {
    return createTaskTools({...input,logger:this.options.logger,isCurrent:()=>!this.closed,helper:this.helperDeps(input),scheduler:this.schedulerDeps});
  }
  observeTask(id:string, listener:(event:AgentEvent)=>void) {const set=this.taskObservers.get(id)??new Set();set.add(listener);this.taskObservers.set(id,set);return ()=>{set.delete(listener);if(!set.size)this.taskObservers.delete(id);};}
  listBindings() { return Object.fromEntries(this.groupBindings); }
  async sessionGroup(id: string) { const row = await this.storage.get(id); return row?.groupBinding ? { groupDeviceId: row.groupBinding.groupDeviceId ?? null, providerId: row.groupBinding.providerId } : null; }
  isTurnRunning(id: string): boolean { return this.steeringSubmissions.has(id) || this.recovering.has(id) || this.turnLifecycle.running(id) || this.starts.has(id) || this.sending.has(id) || this.activeSubmissions.has(id) || this.live.get(id)?.session.isTurnRunning() === true; }
  async submitScheduled(id: string, text: string, origin: Omit<ScheduledOrigin, 'kind'> & { requestId?: string; assertCurrent?: () => void }) {
    return this.submit(id, { text }, { requestId: origin.requestId ?? randomUUID() }, { source: 'local', assertCurrent: origin.assertCurrent, scheduler: { kind: 'scheduler', scheduleId: origin.scheduleId, scheduleName: origin.scheduleName, runId: origin.runId, firedAt:origin.firedAt } });
  }
  isBusy(): boolean { return this.hosted.size > 0 || this.starts.size > 0 || this.sending.size > 0 || this.pending.size > 0 || [...this.queuedSubmissions.values()].some(queue => queue.length > 0) || [...this.live.values()].some(task => this.isTurnRunning(task.session.id)); }
  isAgentAvailable(kind: AgentKind): boolean { return Boolean(this.binaries.get(kind)); }
  async refreshBinaries(paths?: Partial<Record<AgentKind, string>>): Promise<void> {
    await Promise.all(ENGINES.map(async kind => this.binaries.set(kind, await findAgentBinary(kind, paths?.[kind] ?? this.options.binaryPaths?.[kind]))));
    this.authCache.clear();
  }
  async purgeHostedTranscripts(hostSessionIds: readonly string[], _nativeIds: readonly string[] = []): Promise<void> {
    await this.ready;
    for(const id of hostSessionIds){ if(!this.hostedRuntimeIds.has(id))continue;
      for(const kind of ['codex','pi'])await rm(path.join(this.options.profileDir,'engines',kind,id),{recursive:true,force:true});
      this.hostedRuntimeIds.delete(id);
    }
    await this.persistHostedIndex();
  }
  private persistHostedIndex(){this.hostedWrites=this.hostedWrites.then(()=>atomicPrivateWrite(path.join(this.options.profileDir,'hosted-runtimes.json'),JSON.stringify([...this.hostedRuntimeIds])));return this.hostedWrites;}
  async startHosted(input: HostedStartInput): Promise<import('@cindy/maker-core').AgentSessionHandle> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.hostSessionId)||await this.storage.get(input.hostSessionId))throw new Error('INVALID_HOST_SESSION_ID');
    this.hostedRuntimeIds.add(input.hostSessionId);await this.persistHostedIndex();
    // Sharing needs a per-run outbound credential boundary; never hand the local
    // native account or long-lived provider key to an isolated guest process.
    const chosen = await this.models.select({ agentKind: input.kind, providerId: input.options.providerId, model: input.options.model });
    if (input.guest && (chosen.route.provider.source !== 'user' || !input.guestProvider || !this.options.authorizeGuestRequest)) throw new Error('GUEST_PROVIDER_PROXY_REQUIRED');
    const authorizeRequest = input.guest && input.guestProvider ? (model: string) => this.options.authorizeGuestRequest!({sessionId:input.hostSessionId,providerId:chosen.selection.providerId,routeToken:input.guestProvider!.routeToken,model}) : chosen.route.provider.source === 'user' && this.options.authorizeHostedRequest ? (model: string) => this.options.authorizeHostedRequest!({sessionId:input.hostSessionId,providerId:chosen.selection.providerId,model}) : undefined;
    if (authorizeRequest && !await authorizeRequest(chosen.selection.model)) throw new Error('GUEST_PROVIDER_UNAUTHORIZED');
    const binary = this.binaries.get(input.kind);
    if (!binary) throw new Error('ENGINE_NOT_INSTALLED');
    let active=true;
    const reviewAbort=new AbortController();
    const guardReview=()=>{this.guard({source:'local'});if(!active)throw new Error('HOSTED_TASK_CLOSED');};
    const reviewAutoPermissionAction=this.permissionReviewer(guardReview,async request=>{
      if(request.sessionId&&request.sessionId!==input.hostSessionId)throw new Error('TASK_AUTHORITY_CHANGED');
      if(authorizeRequest&&!await authorizeRequest(chosen.selection.model))throw new Error('GUEST_PROVIDER_UNAUTHORIZED');
      const {delegatedTask:_delegation,authorizationError:_error,...ordinary}=request;
      return ordinary;
    },reviewAbort.signal);
    const agent = await (this.options.createAgent ?? createTerminalAgent)({ reviewAutoPermissionAction, profileDir: this.options.profileDir, taskId: input.hostSessionId, selection: chosen.selection, route: chosen.route, binaryPath: binary, models: this.models, logger: this.options.logger, authorizeRequest, ...(input.guest ? {guestHome:input.guestHome} : {}) });
    try {
      const handle = await agent.startSession(hostedStartOptions(input));
      const close = handle.close.bind(handle);
      handle.close = async () => { active=false;reviewAbort.abort();this.hosted.delete(handle); try { await close(); } finally { await agent.dispose(); } };
      if (this.closed) { await handle.close(); throw new Error('TASK_HOST_CLOSED'); }
      this.hosted.add(handle);
      return handle;
    } catch (error) { active=false;reviewAbort.abort();await agent.dispose(); throw error; }
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
    if (input.agentKind && !input.model && !input.providerId) {
      const preferred = (await this.models.snapshot()).defaultSelection;
      if (preferred?.agentKind === input.agentKind) return this.models.select({ ...preferred, ...(input.effort ? { effort: input.effort } : {}) });
    }
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
  private async admitTask(input: Record<string, unknown>, id: string, guard: () => void) {
    if (this.options.resolveExecutionRoute) { const execution = await this.options.resolveExecutionRoute(input, id); if (execution) input = { ...input, ...execution }; guard(); }
    let resolved = await this.selection(input);
    if (this.options.resolveExecutionRoute && !input.groupBinding) {
      const execution = await this.options.resolveExecutionRoute({ ...input, ...resolved.selection }, id);
      guard();
      if (execution) { input = { ...input, ...execution }; resolved = await this.selection(input); }
    }
    guard();
    const cwd = input.workingDir ?? input.workDir ?? path.join(this.options.profileDir, 'workspaces', id);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('WORKING_DIRECTORY_MUST_BE_ABSOLUTE');
    if (!input.workingDir && !input.workDir) await privateDirectory(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
    guard();
    return { input, resolved, cwd };
  }
  channelRepository(config: ImOrchestratorConfig, namespace: ImSessionNamespace, options: { projectSwitching?: boolean } = {}) {
    const guard = () => this.guard({ source: 'local' });
    return createTerminalImSessionRepo({
      ready: this.ready, storage: this.storage, bindings: this.channelBindings, defaults: this.channelSessionDefaults,
      assertCurrent: guard,
      admit: async (row, title) => {
        const { input, resolved, cwd } = await this.admitTask({ ...row, title, workingDir: row.workingDir }, row.id, guard);
        return { id: row.id, ...resolved.selection, workDir: cwd, title, permissionMode: permission(row.permissionMode), fastMode: row.fastMode, ...(input.agentDeviceId ? { agentDeviceId: string(input.agentDeviceId) } : {}), ...(input.groupBinding ? { groupBinding: input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding } : {}) };
      },
      changed: (row, kind) => {
        this.emit('terminal:tasks:changed', { sessionId: row.id });
        this.emit(`local-db:sessions:${kind}`, kind === 'created' ? { sessionId: row.id } : { sessionId: row.id, patch: this.guiSession(row) });
      },
      warn: message => this.options.logger.warn(message),
    }, config, namespace, options);
  }
  private async create(input: Record<string, unknown>, guard: () => void, plugin?: {id:string;hidden?:boolean;onPersistenceStarted():void}, remoteWorker?: {id:string;lead:OrcaRemoteLead}, collaboration?: { id: string; role: 'worker' }) {
    const id = plugin?.id ?? remoteWorker?.id ?? collaboration?.id ?? randomUUID();
    const admitted = await this.admitTask(input, id, guard);
    const { resolved } = admitted;
    // Plugin task roots become authorization facts for later worker plans.
    // Persist their admitted identity, including macOS /var → /private/var.
    const cwd = plugin ? await realpath(admitted.cwd) : admitted.cwd;
    input = admitted.input;
    if (input.fastMode !== undefined && typeof input.fastMode !== 'boolean' && input.fastMode !== 'ultrafast') throw new Error('INVALID_ARGUMENT');
    if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== 'boolean') throw new Error('INVALID_ARGUMENT');
    guard(); plugin?.onPersistenceStarted();
    await this.storage.create({
      ...(plugin ? { source: 'plugin', hiddenAt: plugin.hidden ? Date.now() : null } : {}),
      ...(remoteWorker ? { orcaRemoteLead: remoteWorker.lead } : {}),
      ...(collaboration ? { orcaRole: collaboration.role } : {}),
      ...(input.workspaceKind === 'dialogue' || input.workspaceKind === 'project' ? { workspaceKind: input.workspaceKind } : {}),
      id, ...resolved.selection, workDir: cwd,
      title: typeof input.title === 'string' ? input.title : typeof this.options.defaultTitle === 'function' ? this.options.defaultTitle() : this.options.defaultTitle ?? 'New task',
      permissionMode: input.permissionMode ? permission(input.permissionMode) : 'default',
      ...(typeof input.planMode === 'boolean' ? { planMode: input.planMode } : {}),
      ...(input.fastMode !== undefined ? { fastMode: input.fastMode as boolean | 'ultrafast' } : {}),
      ...(typeof input.thinkingEnabled === 'boolean' ? { thinkingEnabled: input.thinkingEnabled } : {}),
      ...(input.agentDeviceId ? { agentDeviceId: string(input.agentDeviceId) } : {}),
      ...(input.groupBinding ? { groupBinding: input.groupBinding as TerminalTaskMeta['groupBinding'] } : {}),
    }, guard);
    guard();
    if(input.groupBinding)this.groupBindings.set(id,input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding);
    guard();
    await this.ensureLive(id, resolved);
    this.emit('terminal:tasks:changed', { sessionId: id });
    return this.view((await this.storage.get(id))!);
  }
  private ensureLive(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute; modelRevision?: number }): Promise<LiveTask> {
    const existing = this.live.get(id);
    if (existing && existing.session.getStatus() === 'active' && (existing.session.isTurnRunning() || existing.capabilityRevision===this.capabilities.revision() && existing.modelRevision===this.models.revision())) return Promise.resolve(existing);
    const starting = this.starts.get(id);
    if (starting) return starting;
    const result = this.start(id, resolved);
    this.starts.set(id, result);
    void result.finally(() => this.starts.delete(id)).catch(() => undefined);
    return result;
  }
  private async start(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute; modelRevision?: number }): Promise<LiveTask> {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    const row = await this.storage.get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const previous = this.live.get(id);
    if (previous) await this.closeTask(id);
    if (!resolved && row.groupBinding && this.options.resolveExecutionRoute) { const execution=await this.options.resolveExecutionRoute({agentDeviceId:row.agentDeviceId,providerId:row.providerId!,model:row.model,agentKind:row.agentKind,groupBinding:row.groupBinding},id); if (!execution) throw new Error('GROUP_UNAVAILABLE'); resolved=await this.selection(execution); }
    const chosen = resolved ?? await this.selection({ agentDeviceId: row.agentDeviceId, agentKind: row.agentKind, providerId: row.providerId, model: row.model, ...(row.effort ? { effort: row.effort } : {}) });
    const modelRevision = 'modelRevision' in chosen && typeof chosen.modelRevision === 'number' ? chosen.modelRevision : this.models.revision();
    if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    const binary = this.binaries.get(chosen.selection.agentKind);
    if (!binary && !row.agentDeviceId) throw new Error('ENGINE_NOT_INSTALLED');
    const capability = await this.capabilities.runtime({workingDir:row.workDir,agentKind:chosen.selection.agentKind});
    const knowledge = await this.knowledge?.createRuntime({ sessionId: id, workingDir: row.workDir, agentKind: chosen.selection.agentKind });
    let lease:LiveTask|undefined,revoked=false;
    const reviewAbort=new AbortController();
    const isCurrent=()=>!this.closed&&!revoked&&(!lease||this.live.get(id)===lease);
    const assertCurrent=()=>{if(!isCurrent())throw new Error('TASK_PLUGIN_SCOPE_REVOKED');};
    const instanceId=()=>{assertCurrent();if(!lease)throw new Error('TASK_NOT_READY');return lease.session.instanceId;};
    let plugin:TerminalPluginTask|undefined;
    try{plugin=await this.pluginFactory?.({sessionId:id,workingDir:row.workDir,source:row.source,instanceId,assertCurrent,snapshot:()=>this.pluginPermissionSnapshot(id,instanceId()),confirm:(payload,signal)=>this.requestPluginWrite(id,payload,signal)});}
    catch(error){await knowledge?.close();await capability.close();throw error;}
    let tools: Awaited<ReturnType<typeof createTaskTools>>;
    try { tools = await createTaskTools({ logger: this.options.logger, sessionId: id, workingDir: row.workDir, agentKind: chosen.selection.agentKind,
      extraProviders: [this.orcaTools.provider, row.orcaRemoteLead && this.options.remoteInvoke ? createOrcaRemoteWorkerMcpProvider(async (context, tool, args) => {
        assertCurrent();
        if (context.sessionId !== id || !lease || context.sessionInstanceId !== lease.session.instanceId) throw new Error('TASK_MCP_SCOPE_MISMATCH');
        const result = await this.remoteWorkerForwarder.forwardTool(context, tool, args);
        assertCurrent(); return result;
      }, this.options.logger) : this.localWorkerMcpProvider(id)],
      extraFactories: {...capability.factories,...knowledge?.factories,...plugin?.factories,...this.channelTools?.(() => {
        if (!isCurrent()) throw new Error('TASK_TOOLS_REVOKED');
        const session = this.live.get(id)?.session;
        if (!session) throw new Error('TASK_NOT_ACTIVE');
        return { sessionId: id, sessionInstanceId: session.instanceId, workingDir: row.workDir, agentKind: chosen.selection.agentKind, vendorOptions: { source: row.source, ...(row.source === 'feishu' && row.imUserId ? { feishuChatId: row.imUserId } : {}) } };
      }, { source: row.source })},
      isCurrent,
      scheduler: this.schedulerDeps,
      helper: this.helperDeps({sessionId:id,workingDir:row.workDir,agentKind:chosen.selection.agentKind,title:()=>row.title}),
    }); } catch(error) { revoked=true;reviewAbort.abort();plugin?.close();await knowledge?.close(); await capability.close(); throw error; }
    const reviewAutoPermissionAction=this.permissionReviewer(assertCurrent,async request=>{
      const current=await this.storage.get(id);
      if(!current||current.deleted||current.archived||current.workDir!==row.workDir||request.sessionId&&request.sessionId!==id)throw new Error('TASK_AUTHORITY_CHANGED');
      const {delegatedTask:_delegation,authorizationError:_error,...ordinary}=request;
      // Plugin-created tasks require their own live receipt; never reinterpret
      // a lost delegation as authority from the owner of an ordinary task.
      const workerLink = current.orcaRole === 'worker' ? await this.orcaStore.getWorkerLink({ workerSessionId: id }) : null;
      const pluginOwned = current.source === 'plugin' || workerLink && (await this.storage.get(workerLink.leadSessionId))?.source === 'plugin';
      if(pluginOwned)return this.pluginSessions ? this.pluginSessions.review(ordinary) : {...ordinary,authorizationError:'The plugin task authorization receipt is unavailable.'};
      return ordinary;
    },reviewAbort.signal);
    let agent;
    try { agent = await (this.options.createAgent ?? createTerminalAgent)({ reviewAutoPermissionAction, profileDir: this.options.profileDir, taskId: id, selection: chosen.selection, route: chosen.route, binaryPath: binary ?? process.execPath, models: this.models, logger: this.options.logger, tools, turnChangeCapture: this.changes.capture, taskShellEnv:()=>this.options.protectedInput?.envFor(id)??{}, remote: Boolean(row.agentDeviceId), capabilities:capability,getGhostRosterPrompt:plugin?.getGhostRosterPrompt, memory: knowledge?.memory, contactsEnabled: knowledge?.contactsEnabled, getContactsPromptState: () => this.knowledge?.snapshot().contacts ? 'enabled' : 'disabled' }); } catch (error) { revoked=true;reviewAbort.abort();plugin?.close();await tools.close(); await knowledge?.close(); await capability.close(); throw error; }
    const startDeviceAgentSession = row.agentDeviceId && this.options.remoteInvoke ? createDeviceAgentStarter({ captureKnownFileBefore: this.changes.capture.beforeKnownFileWrite, noteOpaqueTurnChange: this.changes.capture.noteOpaqueWrite, remoteInvoke: this.options.remoteInvoke, rgPath: () => 'rg', codexPath: () => this.binaries.get('codex') ?? undefined, mcpProviders: () => tools.providers, prepareMcpBridge: async (_providers, _logger, context) => tools.pi(context), makerMemory: () => knowledge?.memory, logger: this.options.logger }) : undefined;
    const maker = new Maker({ agents: { [chosen.selection.agentKind]: agent }, storage: this.storage, logger: this.options.logger, ...(knowledge ? {makerMemory:knowledge.memory} : {}), ...(startDeviceAgentSession ? { startDeviceAgentSession } : {}) });
    const stopObservingMaker = maker.on(event => {
      for (const observer of this.makerObservers) {
        try { observer(event); } catch { this.options.logger.warn('Channel task lifecycle observer failed'); }
      }
    });
    try {
      if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
      const createOptions: MakerSessionCreateOpts = { id, agentKind: chosen.selection.agentKind, workingDir: row.workDir, title: row.title, ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}), model: chosen.selection.model, providerId: chosen.selection.providerId, effort: chosen.selection.effort, permissionMode: row.permissionMode, fastMode: row.fastMode, planMode: row.planMode, thinkingEnabled: row.thinkingEnabled, vendorOptions: this.channelBindings.store.findByTarget(id) ? undefined : this.channelOrchestrators.vendorOptionsForSession(id) ?? this.channelVendorOptions.get(id), ...(row.sdkSessionId ? { resumeSessionId: row.sdkSessionId } : {}) };
      const bootstrap = this.orcaBootOptions.get(id);
      if (bootstrap?.vendorOptions) createOptions.vendorOptions = { ...createOptions.vendorOptions, ...bootstrap.vendorOptions };
      const didInjectOrcaInstructions = await preparePersistedOrcaSessionStart(id, createOptions, {
        getSessionRole: taskId => this.orcaStore.getSessionOrcaRole(taskId),
        getWorkerLink: taskId => this.orcaStore.getWorkerLink({ workerSessionId: taskId }),
        getRemoteLead: async taskId => (await this.storage.get(taskId))?.orcaRemoteLead ?? null,
        warn: (message, fields) => this.options.logger.warn(message, fields),
      });
      assertCurrent();
      const session = await maker.createSession(createOptions);
      if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
      const task: LiveTask = { didInjectOrcaInstructions, revoke:()=>{revoked=true;reviewAbort.abort();plugin?.close();},plugin,capabilityRevision:capability.revision,modelRevision, maker, session, selection: chosen.selection, dispose: [() => {revoked=true;reviewAbort.abort();plugin?.close();}, () => tools.close(), () => knowledge?.close(), () => capability.close()] };
      installDesktopInteractionHandler(session,(request,shared)=>this.interaction(id,request,undefined,shared),(sourceRequestId,decision)=>{
        for(const pending of this.pending.values())if(pending.sessionId===id&&pending.sourceRequestId===sourceRequestId){pending.settle(decision);return true;}
        return false;
      });
      task.dispose.push(this.turnLifecycle.bind(session));
      task.dispose.push(session.onEvent(event => this.onEvent(id, event)));
      task.dispose.push(session.onStatusChange(status => this.emit('maker:status-changed', { sessionId: id, status })));
      task.dispose.push(stopObservingMaker);
      lease=task;this.live.set(id, task);
      if (this.closed) { await this.closeTask(id); throw new Error('TASK_HOST_CLOSED'); }
      return task;
    } catch (error) { revoked=true;reviewAbort.abort();plugin?.close();try { await maker.shutdown(); } finally { stopObservingMaker(); } await tools.close(); await knowledge?.close(); await capability.close(); throw error; }
  }
  private onEvent(id: string, event: AgentEvent) {
    const runtime = this.live.get(id)?.session;
    if (runtime && event.type === 'error' && event.turnScope !== 'background' && (event.data as { isTerminal?: boolean } | undefined)?.isTerminal !== false) {
      const identity = { instanceId: event.sessionInstanceId, generation: event.sessionTurnGeneration };
      const recoverable = !this.stoppingTasks.has(id) && this.activeSubmissions.has(id) && this.externalSubmissions.get(id) !== this.activeSubmissions.get(id)
        && !event.turnOrigin && !this.channelBindings.store.findByTarget(id) && !this.pluginSetup?.surface.isHeadlessGhostSetupTurn(id)
        && (isContextOverflowErrorData(event.data) || isOversizedHistoryErrorData(event.data) || isUnsupportedRequestOptionErrorData(event.data));
      const claim = this.routes.recovery.runtime.claim(id, identity, recoverable);
      if (claim === 'in-flight') return;
      if (claim === 'claimed') {
        const requestId = this.activeSubmissions.get(id);
        // Let the native terminal boundary finish before closing/rebuilding its
        // Session. Keep the same submission occupied throughout the replay.
        const work = Promise.resolve().then(async () => {
          const recovered = await this.routes.recovery.runtime.tryRecover(id, event.data, identity);
          if (!recovered && !this.closed && this.activeSubmissions.get(id) === requestId) this.persistTaskEvent(id, event, requestId);
        }).catch(() => {
          if (!this.closed && this.activeSubmissions.get(id) === requestId) this.persistTaskEvent(id, event, requestId);
        }).finally(() => {
          if (this.recovering.get(id) === work) this.recovering.delete(id);
          setImmediate(() => this.drain(id));
        });
        this.recovering.set(id, work);
        return;
      }
    }
    this.persistTaskEvent(id, event, this.activeSubmissions.get(id));
  }
  private persistTaskEvent(id: string, event: AgentEvent, sourceRequestId?: string) {
    const runtime = this.live.get(id)?.session;
    const currentOrcaTurn = runtime && event.turnScope !== 'background'
      && event.sessionInstanceId === runtime.instanceId && event.sessionTurnGeneration === runtime.getTurnGeneration();
    const terminalOrcaTurn = currentOrcaTurn && (event.type === 'done' && (event.data as { silentStop?: boolean } | undefined)?.silentStop !== true
      || event.type === 'error' && (event.data as { isTerminal?: boolean } | undefined)?.isTerminal !== false);
    const orcaCapture = terminalOrcaTurn ? this.orcaTeamService.captureWorkerTerminalTurn(id) : undefined;
    if (currentOrcaTurn && event.type === 'text') {
      const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
      const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
      this.orcaTeamService.captureWorkerText(id, text, { isFinal: data.isFinal === true });
    }
    if (runtime) this.changes.observe(runtime, event);
    for(const observer of this.taskObservers.get(id)??[])observer(event);
    // Generated byte payloads are host-owned, not durable conversation text.
    let saved = event;
    if (event.type === 'tool_use' && event.data && typeof event.data === 'object') {
      const data = event.data as Record<string, unknown>;
      saved = { ...event, data: { ...data, input: redactToolInputForUntrustedBoundary(String(data.toolName ?? ''), data.input) } };
    }
    if (event.type === 'image' && event.data && typeof event.data === 'object') {
      const { data: _bytes, ...data } = event.data as Record<string, unknown>;
      saved = { ...event, data };
    }
    void this.storage.append(id, { kind: 'event', event: saved, clientId: sourceRequestId }).then(async row => {
      this.emit('maker:event', { sessionId: id, event: saved, sequence: row.sequence });
      const requestId = this.activeSubmissions.get(id) === sourceRequestId ? sourceRequestId : undefined;
      if (requestId && event.turnScope !== 'background' && event.type === 'text') {
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { text: String(event.data ?? '') };
        const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
        this.submissionText.set(id, data.isFinal === true ? text : (this.submissionText.get(id) ?? '') + text);
      }
      const silentStop = event.type === 'done' && (event.data as { silentStop?: boolean } | undefined)?.silentStop === true;
      if (orcaCapture) {
        const turn = { sessionId: id, status: event.type === 'done' ? 'done' as const : 'error' as const,
          finalText: this.submissionText.get(id) ?? '', capture: orcaCapture,
          ...(event.type === 'error' ? { diagnostic: 'TURN_FAILED' } : {}) };
        await this.orcaReports.terminal(id, sourceRequestId, turn, () => this.orcaTeamService.handleWorkerTerminalTurn(turn))
          .catch(() => this.options.logger.warn('ORCA_TERMINAL_REPORT_FAILED'));
      }
      if (event.type === 'done' && !silentStop) { void this.messages(id,{limit:1}).then(rows=>{if(rows[0]?.role==='assistant')this.emit('local-db:messages:created',{sessionId:id,message:rows[0]});}).catch(()=>{}); setImmediate(() => this.drain(id)); const usage = this.live.get(id)?.session.getUsageSnapshot(); if (usage) void this.storage.update(id, { usage }).catch(() => this.persistenceFaults.add(id)); }
      if (requestId && !silentStop && event.turnScope !== 'background' && (event.type === 'done' || (event.type === 'error' && (event.data as { isTerminal?: boolean })?.isTerminal !== false))) {
        this.activeSubmissions.delete(id);
        this.externalSubmissions.delete(id);
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
  private interaction(id: string, request: InteractionRequest, signal?: AbortSignal, shared?:SharedPermission, ownerSetting = false): Promise<InteractionDecision> {
    const publicRequest = { ...request, ...(request.kind === 'permission' ? { input: redactToolInputForUntrustedBoundary(request.toolName, request.input) as Record<string, unknown> } : {}), requestId: randomUUID() };
    return new Promise(resolve => {
      let finished=false;
      const settle = (decision: InteractionDecision) => {
        if(finished)return;
        finished=true;
        pending.shared?.settle(decision);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(publicRequest.requestId);
        this.emit('maker:interaction-dismissed', { sessionId: id, requestId: publicRequest.requestId });
        resolve(pending.shared?.decision??decision);
      };
      const cancel = () => settle(decisionForDismissal(publicRequest));
      const pending:Pending={sessionId:id,sourceRequestId:request.requestId,request:publicRequest,settle,shared,decide:decision=>{
        if(decision.kind!==request.kind||finished||pending.shared?.decision||pending.deferred||this.pending.get(publicRequest.requestId)!==pending)return false;
        if(this.queuePaused.has(id)&&!ownerSetting){pending.deferred=decision;return true;}
        settle(decision);
        return true;
      }};
      this.pending.set(publicRequest.requestId,pending);
      if(shared){shared.decide=decision=>decision.kind==='permission'&&pending.decide(decision);void shared.result.then(settle);}
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || this.closed) { cancel(); return; }
      this.emit('maker:interaction-request', { sessionId: id, request: publicRequest });
    });
  }
  /** Taking over an already-running task shares permissions with its original
   * terminal. Other cards transfer presentation only; the host retains stop,
   * cancellation and deferred-answer ownership. */
  takeChannelInteractions(id: string): ReturnType<ImTurnHost['takePendingInteractionsForSession']> {
    this.guard({ source: 'local' });
    const taken: ReturnType<ImTurnHost['takePendingInteractionsForSession']> = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== id || pending.migrated || pending.shared) continue;
      if (pending.request.kind === 'permission') {
        const shared = createSharedPermission();
        pending.shared = shared;
        shared.decide = decision => decision.kind === 'permission' && pending.decide(decision);
        void shared.result.then(pending.settle);
        taken.push({ requestId, request: pending.request, sharedPermission: shared, resolve: shared.decide });
      } else {
        pending.migrated = true;
        taken.push({ requestId, request: pending.request, resolve: decision => { pending.decide(decision); } });
        this.emit('maker:interaction-dismissed', { sessionId: id, requestId, reason: 'migrated_to_feishu' });
      }
    }
    return taken;
  }
  private permissionUpdates(value: unknown): Record<string,unknown>[] {
    if(!Array.isArray(value)||value.length===0)throw new Error('INVALID_PERMISSION_UPDATES');
    return value.map(record);
  }
  private assertSharedInteraction(id:string,decision:Record<string,unknown>) {
    const request=this.pending.get(id)?.request;
    const deny=()=>{throw new Error('SHARED_TASK_PERMISSION_DENIED');};
    if(!request||!['permission','ask_user_question','plan_review'].includes(request.kind)||decision.kind!==request.kind||decision.updatedInput!==undefined)deny();
    if(request!.kind!=='permission') {if(decision.permissionUpdates!==undefined)deny();return;}
    const permission=request as Extract<InteractionRequest,{kind:'permission'}>;
    if(['cindy.app.update','cindy.app.auto_update'].includes(permission.toolName))deny();
    if(decision.permissionUpdates===undefined)return;
    const updates=this.permissionUpdates(decision.permissionUpdates);
    const suggestions=permission.suggestions;
    if(!Array.isArray(suggestions))deny();
    for(const update of updates){
      if(update.destination!=='session')deny();
      if(update.type==='codexSessionApproval'){if(Object.keys(update).some(key=>!['type','destination'].includes(key)))deny();}
      else if(update.type!=='addRules'||update.behavior!=='allow'||Object.keys(update).some(key=>!['type','behavior','destination','rules'].includes(key))||!Array.isArray(update.rules)||!update.rules.length||!update.rules.every(raw=>{const rule=record(raw);return rule.toolName===permission.toolName&&Object.keys(rule).every(key=>['toolName','ruleContent'].includes(key))&&(rule.ruleContent===undefined||typeof rule.ruleContent==='string');}))deny();
      if(!suggestions!.some(suggestion=>JSON.stringify(suggestion)===JSON.stringify(update)))deny();
    }
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
        ? { kind: 'permission', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(raw.updatedInput !== undefined ? { updatedInput: record(raw.updatedInput) } : {}), ...(raw.permissionUpdates !== undefined ? { permissionUpdates: this.permissionUpdates(raw.permissionUpdates) } : {}) }
        : { kind: 'plan_review', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(typeof raw.editedPlan === 'string' ? { editedPlan: raw.editedPlan } : {}) };
    }
    return { success: pending.decide(decision) };
  }
  private async closeTask(id: string) {
    this.options.protectedInput?.handoff.cleanupForSession(id);
    this.pluginSetup?.bridge.cleanupForSession(id,'session_closed');
    const task = this.live.get(id);
    if (!task) return;
    this.remoteWorkerTurns.delete(id);
    // Interrupted turns may have newer usage than the last done event. Save the
    // final live reading before detach so a cold model switch sees that pressure.
    await this.storage.updateIf(id, row => !row.deleted, { usage: task.session.getUsageSnapshot() }, () => {});
    for (const pending of [...this.pending.values()]) if (pending.sessionId === id) pending.settle(decisionForDismissal(pending.request));
    const requestId = this.activeSubmissions.get(id);
    if (requestId && !this.routeClosures.has(id)) { this.activeSubmissions.delete(id); this.externalSubmissions.delete(id); await this.updateReceipt(id, requestId, 'interrupted', 'SESSION_CLOSED', this.submissionText.get(id)); this.submissionText.delete(id); }
    task.revoke();
    if (this.routeClosures.has(id)) await task.maker.closeSession(id, 'agent-switch');
    await task.maker.shutdown();
    await this.changes.store.finalizeTurnChangeSet(id, null, 'partial');
    this.changes.store.clearPendingTurnChangeSets(id);
    for (const dispose of task.dispose) await dispose();
    this.live.delete(id);
  }
  private async cancelTaskRecovery(id: string) {
    const work = this.recovering.get(id);
    this.routes.recovery.runtime.cancelRecovery(id);
    if (!work) return;
    const requestId = this.activeSubmissions.get(id);
    await work;
    if (requestId && this.activeSubmissions.get(id) === requestId) {
      this.activeSubmissions.delete(id);
      this.externalSubmissions.delete(id);
      await this.updateReceipt(id, requestId, 'interrupted', 'INPUT_STOPPED', this.submissionText.get(id));
      this.submissionText.delete(id);
    }
  }
  private guard(context: TaskInvocationContext) {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (context.signal?.aborted) throw new Error('REQUEST_ABORTED');
    context.assertCurrent?.();
  }
  async invoke(channel: string, args: unknown[] = [], context: TaskInvocationContext = { source: 'local' }): Promise<unknown> {
    this.guard(context);
    const stopsTask = ['maker:input:stop', 'maker:abort-session', 'maker:close-session', 'terminal:tasks:delete'].includes(channel)
      || channel === 'local-db:sessions:update' && record(args[1] ?? {}).status !== undefined && record(args[1]).status !== 'active';
    const stoppingId = stopsTask ? string(args[0]) : undefined;
    if (stoppingId) {
      this.stoppingTasks.set(stoppingId, (this.stoppingTasks.get(stoppingId) ?? 0) + 1);
      this.steeringSubmissions.get(stoppingId)?.controller.abort();
    }
    try {
      const result = await this.dispatch(channel, args, context);
      this.guard(context);
      if(channel.startsWith('maker:input:')&&channel!=='maker:input:get-projection')this.emit('maker:input:projection',result);
      return result;
    } finally {
      if (stoppingId) {
        const remaining = (this.stoppingTasks.get(stoppingId) ?? 1) - 1;
        if (remaining) this.stoppingTasks.set(stoppingId, remaining);
        else this.stoppingTasks.delete(stoppingId);
        if (!remaining && channel === 'maker:input:stop' && record(args[1] ?? {}).pauseQueue === false) this.drain(stoppingId);
      }
    }
  }
  private async dispatch(channel: string, args: unknown[], context: TaskInvocationContext): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (!Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
    this.guard(context);
    if (context.source==='remote'&&(channel==='maker:model-disable:set'||['maker:provider:test-connection','maker:provider:models-fetch'].includes(channel)))throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('terminal:models:')) throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && (!context.ownerId || !context.deviceId || !context.assertCurrent)) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && args[1] && Object.keys(record(args[1])).length) throw new Error('PROTECTED_SECRET_SUBMISSION_REQUIRED');
    if (context.sharedTask) {
      const allowed = ['local-db:messages:around','local-db:messages:around-client-id','local-db:messages:view','local-db:messages:view-intent','local-db:messages:work-details','maker:provider:list', 'maker:get-capabilities', 'maker:input:stop', 'maker:input:resume', 'maker:input:remove', 'maker:input:update-text', 'maker:input:update-content', 'maker:input:move', 'maker:input:set-expanded', 'maker:input:set-edit-lock', 'maker:input:set-interaction-lock', 'maker:input:enqueue', 'maker:input:get-projection', 'maker:send', 'maker:abort-session', 'maker:session-in-turn', 'maker:get-context-usage', 'maker:get-pending-interactions', 'maker:resolve-interaction', 'local-db:sessions:get', 'local-db:messages:list', 'local-db:history:messages', 'terminal:tasks:turn-status'];
      if (!allowed.includes(channel)) throw new Error('SHARED_TASK_PERMISSION_DENIED');
      if(channel==='maker:provider:list' && args.length && (args.length>1||!args[0]||typeof args[0]!=='object'||Object.keys(args[0] as object).some(key=>!['includeCapabilities','capabilities'].includes(key))))throw new Error('INVALID_ARGUMENT');
      if(channel==='maker:get-capabilities'&&!ENGINES.includes(args[0] as AgentKind))throw new Error('INVALID_ENGINE');
      const target = channel==='maker:provider:list'||channel==='maker:get-capabilities' ? context.sharedTask.sessionId : channel === 'maker:resolve-interaction' ? this.pending.get(string(args[0]))?.sessionId : channel === 'local-db:history:messages' ? record(args[0]).sessionId : args[0];
      if (target !== context.sharedTask.sessionId) throw new Error('SHARED_TASK_SCOPE_MISMATCH');
    }
    const stopWorker = ['maker:input:stop', 'maker:abort-session', 'maker:close-session', 'terminal:tasks:delete'].includes(channel)
      || channel === 'local-db:sessions:update' && record(args[1] ?? {}).status !== undefined && record(args[1]).status !== 'active';
    // Revoke recovery before the first asynchronous metadata/report read. Its
    // commit guard must already be cancelled if a waiting write resumes now.
    if (stopWorker) this.routes.recovery.runtime.cancelRecovery(string(args[0]));
    if (stopWorker && (await this.storage.get(string(args[0])))?.orcaRole === 'worker') {
      this.guard(context);
      this.manualOrcaInterrupts.set(string(args[0]), { markedAt: Date.now(), reason: 'user_stop' });
      await this.orcaReports.suppress(string(args[0]), this.activeSubmissions.get(string(args[0])));
    }
    if (REMOTE_WORKER_CHANNELS.includes(channel as typeof REMOTE_WORKER_CHANNELS[number])) return this.remoteWorkers(channel, args, context);
    if (ORCA_CONTROL_CHANNELS.includes(channel as typeof ORCA_CONTROL_CHANNELS[number])) {
      if (context.source === 'remote' && (!context.deviceId || !context.ownerId || !context.assertCurrent)) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
      return this.orcaAction.run(() => this.guard(context), () => this.orcaIpc.invoke(channel, args));
    }
    if(CAPABILITY_CHANNELS.includes(channel))return this.capabilities.invoke(channel,args,context);
    switch (channel) {
      case 'maker:generate-title': {
        const input = record(args[0]);
        if (typeof input.message !== 'string' || input.agentKind !== undefined && !ENGINES.includes(input.agentKind as AgentKind)) throw new Error('INVALID_ARGUMENT');
        return { title: await this.generateTaskTitle({ message: input.message, ...(input.sessionId ? { sessionId: string(input.sessionId) } : {}), ...(input.agentKind ? { agentKind: input.agentKind as AgentKind } : {}) }) };
      }
      case 'maker:input:stop': {
        const id=string(args[0]),opts=args[1]?record(args[1]):{};this.queuePaused.add(id);
        await this.cancelTaskRecovery(id);
        await this.storage.update(id,{queuePaused:opts.pauseQueue!==false});
        if(opts.keepQueue===false)for(const item of await this.storage.queued(id))await this.removeQueued(id,item.requestId,context);
        const task=this.live.get(id);if(task)await this.turnLifecycle.stop(task.session);if(opts.pauseQueue===false){this.queuePaused.delete(id);this.drain(id);}return this.projection(id);
      }
      case 'maker:input:resume': {const id=string(args[0]);await this.storage.update(id,{queuePaused:false});this.queuePaused.delete(id);for(const pending of this.pending.values())if(pending.sessionId===id&&pending.deferred){const decision=pending.deferred;pending.deferred=undefined;pending.decide(decision);}this.drain(id);return this.projection(id);}
      case 'maker:input:remove': {const id=string(args[0]);await this.removeQueued(id,string(args[1]),context);return {...await this.projection(id),inputDeliveryCancelled:true};}
      case 'maker:input:update-text':case 'maker:input:update-content': {
        const id=string(args[0]),clientId=string(args[1]);await this.mutateQueued(id,async()=>{const previous=await this.requireQueued(id,clientId,context);
          const incoming=channel.endsWith('update-text')?{type:'user',content:typeof previous.message?.content==='string'?string(args[2]):[{type:'text',text:string(args[2])},...(previous.message?.content??[]).filter(block=>block.type!=='text')]}:args[2];
          const message=await this.message(id,incoming,context);this.guard(context);await this.storage.editQueuedSubmission(id,clientId,{message,sharedTask:context.sharedTask,deviceId:context.deviceId,source:context.source,deliveryProof:undefined,orca:undefined,collaboration:undefined},()=>this.guard(context));
          this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(clientId);
          const item=this.queuedSubmissions.get(id)?.find(item=>item.requestId===clientId);if(item){item.message=message;item.context={...context,plugin:previous.plugin,targetPlugin:previous.targetPlugin,signal:undefined};}
        });return this.projection(id);
      }
      case 'maker:input:move': {
        const id=string(args[0]);await this.mutateQueued(id,async()=>{await this.requireQueued(id,string(args[1]),context);const queue=[...(this.queuedSubmissions.get(id)??[])];const index=queue.findIndex(item=>item.requestId===args[1]);const destination=Number(args[2]);if(index<0||!Number.isInteger(destination)||destination<0||destination>=queue.length)throw new Error('INVALID_QUEUE_INDEX');queue.splice(destination,0,...queue.splice(index,1));await this.storage.reorderQueued(id,queue.map(item=>item.requestId),()=>this.guard(context));const order=queue.map(item=>item.requestId);this.queuedSubmissions.get(id)?.sort((a,b)=>order.indexOf(a.requestId)-order.indexOf(b.requestId));});return this.projection(id);
      }
      case 'maker:input:set-expanded':{const id=string(args[0]);await this.storage.update(id,{queueExpanded:args[1]===true});return this.projection(id);}
      case 'maker:input:set-edit-lock':case 'maker:input:set-interaction-lock':{const id=string(args[0]);const map=channel.endsWith('edit-lock')?this.queueEditLocks:this.queueLocks;const locks=map.get(id)??new Set<string>();args[2]===true?locks.add(string(args[1])):locks.delete(string(args[1]));map.set(id,locks);this.drain(id);return this.projection(id);}

      case 'maker:git-safety:get': return {mode:'off',autoSnapshotEnabled:false,isCustomized:false};
      case 'maker:turn-change-sets:list': return this.changes.store.listTurnChangeSets(string(args[0]));
      case 'maker:turn-change-sets:get': {
        if (!Array.isArray(args[1]) || args[1].length > 16 || args[1].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id))) throw new Error('INVALID_ARGUMENT');
        return this.changes.store.getTurnChangeSets(string(args[0]), args[1] as string[]);
      }
      case 'maker:turn-change-set:apply': {
        if (args[2] !== 'undo' && args[2] !== 'reapply') throw new Error('INVALID_ARGUMENT');
        return this.changes.apply(string(args[0]), string(args[1]), args[2], () => this.guard(context));
      }
      case 'maker:get-new-maker-defaults': { const selection=(await this.models.snapshot()).defaultSelection; return selection && selection.agentKind===args[0] ? {model:selection.model,providerId:selection.providerId,effort:selection.effort,permissionMode:'default',hasExplicitModel:true} : {}; }
      case 'maker:get-capabilities': {
        const kind=string(args[0]) as AgentKind;if(!ENGINES.includes(kind))throw new Error('INVALID_ENGINE');
        const capabilities=this.channelRuntime().getCapabilities(kind);
        return {...capabilities,supportsSessionAgentSwitch:true,supportsSessionAgentSwitchCas:true,supportsModelWindowSwitchGuard:true,supportsScheduleIntervalNullClear:true,supportsSchedulePreRunHook:true};
      }
      case 'maker:get-session-tree': return (await this.ensureLive(string(args[0]))).session.getSessionTree();
      case 'maker:set-thinking-enabled': {if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');const id=string(args[0]);await (await this.ensureLive(id)).session.setThinkingEnabled(args[1]);await this.storage.update(id,{thinkingEnabled:args[1]});return {success:true};}

      case 'maker:session:handoff': {
        if(context.source!=='remote'||!context.deviceId||!context.assertCurrent||context.sharedTask)throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        if(record(args[0]).action==='task-action-capability')return {taskActionVersion:1};
        if(record(args[0]).action==='validate-task-action')return {valid:false};
        const proof=readTaskDelivery(args[0],context.deviceId);await validateTaskDelivery(this.options.remoteInvoke,proof);this.guard(context);
        const row=await this.storage.get(proof.targetSessionId);if(!row||row.deleted)throw new Error('TASK_NOT_FOUND');if(row.archived)throw new Error('TASK_ARCHIVED');
        const receipt=await this.submit(proof.targetSessionId,{text:proof.message},{requestId:`handoff_${createHash('sha256').update(JSON.stringify([proof.controllerDeviceId,proof.receiptId])).digest('hex')}`},{...context,deliveryProof:proof});
        return {ok:true,agentKind:row.agentKind,wakeKind:receipt.status==='queued'?'queued':'already-active',targetTitle:row.title,targetLastUserSendAt:null};
      }

      case 'binding:resolve-session': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        const identity = typeof args[0] === 'string' ? this.channelBindings.store.findByTarget(args[0]) : null;
        return { attached: identity !== null, identity, displayName: null };
      }
      case 'binding:list-attached': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        return { sessionIds: this.channelBindings.store.listAttachedTargets() };
      }
      case 'binding:revoke': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        const id = string(args[0]), identity = this.channelBindings.store.findByTarget(id);
        if (!identity || !await this.channelBindings.store.detachIfTarget(identity, id)) return { ok: true, alreadyDetached: true };
        this.guard(context);
        await this.channelOrchestrators.notifyRevoked(identity).catch(() => this.options.logger.warn('IM_DETACH_NOTICE_FAILED'));
        return { ok: true, alreadyDetached: false };
      }
      case 'local-db:history:messages': return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context)).messages(args[0]);
      case 'local-db:history:query': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context)).query(args[0]);
      }
      case 'maker:input:get-projection': return this.projection(string(args[0]), args[1] === undefined ? {} : record(args[1]));
      case 'maker:input:enqueue': {
        const id = string(args[0]); const item = record(args[1]);
        const orca = await readRemoteWorkerAssignment(this.storage, id, item, context);
        context = { ...context, orca };
        await this.submit(id, item, { ...(args[2] ? record(args[2]) : {}), requestId: string(item.clientId) }, context);
        return this.projection(id);
      }
      case 'maker:create-session': return this.create(record(args[0] ?? {}), () => this.guard(context));
      case 'terminal:tasks:submit': return this.submit(string(args[0]), args[1], args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:turn-status': { const receipt = await this.storage.submission(string(args[0]), string(args[1])); if (!receipt) throw new Error('SUBMISSION_NOT_FOUND'); return this.receiptView(receipt); }
      case 'terminal:tasks:status': return this.storage.submission(string(args[0]), string(args[1]));
      case 'terminal:tasks:wait': return this.waitReceipt(string(args[0]), string(args[1]), args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:list': return (await this.storage.list()).filter(row=>!row.hiddenAt).map(row => this.view(row));
      case 'local-db:sessions:list': return (await this.storage.list()).filter(row=>!row.hiddenAt).filter(row => args[1] === 'archived' ? row.archived && !row.deleted : args[1] === 'deleted' ? row.deleted : !row.archived && !row.deleted).slice(0, typeof args[0] === 'number' ? Math.min(1000, Math.max(1, args[0])) : 100).map(row => this.guiSession(row));
      case 'local-db:sessions:get': { const row = await this.storage.get(string(args[0])); return row ? this.guiSession(row) : null; }
      case 'local-db:orca-workflows:get-by-lead': return this.orcaStore.getTeamByLeadSession(string(args[0]));
      case ORCA_EXECUTION_DEVICES_CHANNEL: return { devices: await this.orcaRemoteController.listExecutionDevices() };
      case 'local-db:orca-workflows:get-by-worker-session': return this.orcaStore.getTeamByWorkerSession(string(args[0]));
      case 'local-db:orca-workflows:list-workers-by-lead': return this.orcaStore.listWorkersByLead(string(args[0]));
      case 'local-db:orca-workflows:list-workers-by-leads': {
        if (!Array.isArray(args[0]) || args[0].length > 200) throw new Error('INVALID_ARGUMENT');
        return this.orcaStore.listWorkersByLeads(args[0].map(id => string(id)));
      }
      case 'local-db:sessions:update': case 'local-db:sessions:patch-meta': return this.patchMeta(string(args[0]), record(args[1]),()=>this.guard(context));
      case 'local-db:messages:list': return this.messages(string(args[0]), args[1] === undefined ? {} : record(args[1]));
      case 'local-db:messages:around': case 'local-db:messages:around-client-id': {
        const id=string(args[0]),key=string(args[1]);const options=args[2]===undefined?{}:record(args[2]);
        const radius=typeof options.radius==='number'?Math.min(100,Math.max(1,Math.floor(options.radius))):20;
        const rows=(await this.messages(id,{limit:Infinity},true)).reverse();
        const index=rows.findIndex(row=>channel.endsWith('around-client-id')?row.clientId===key:row.id===key);
        if(index<0)return [];
        return rows.slice(Math.max(0,index-radius),index+radius+1);
      }
      case 'local-db:messages:view': return this.historyView().page(string(args[0]),typeof record(args[1]??{}).before==='string'?record(args[1]).before as string:undefined,record(args[1]??{}).lazyDetails===true);
      case 'local-db:messages:work-details': return this.historyView().details(string(args[0]),record(args[1]) as unknown as HistoryWorkReference,typeof record(args[2]??{}).after==='string'?record(args[2]).after as string:undefined);
      case 'local-db:messages:view-intent': return null;
      case 'terminal:tasks:get': { const row = await this.storage.get(string(args[0])); if (!row) throw new Error('TASK_NOT_FOUND'); return this.view(row); }
      case 'terminal:tasks:history': { const page = args[1] === undefined ? {} : record(args[1]); return this.storage.history(string(args[0]), Number(page.after ?? 0), Number(page.limit ?? 200)); }
      case 'terminal:tasks:rename': { const row = await this.storage.update(string(args[0]), { title: string(args[1]) }); this.emit('terminal:tasks:changed', { sessionId: row.id }); return this.view(row); }
      case 'terminal:tasks:delete': { const id = string(args[0]); await this.cancelTaskRecovery(id); if (this.starts.has(id)) throw new Error('TASK_STARTING'); await this.options.beforeTaskUnavailable?.(id); this.guard(context); await this.closeTask(id); const channelFilesRoot=this.channelFiles.imAttachmentsRoot(); const channelIdentity=this.channelBindings.store.findByTarget(id); if(channelIdentity)await this.channelBindings.store.detachIfTarget(channelIdentity,id); await this.storage.delete(id); await this.media.removeSession(id); await this.channelFiles.removeImSessionAttachmentDirs(id,channelFilesRoot); this.channelVendorOptions.delete(id); this.emit('terminal:tasks:changed', { sessionId: id }); return { success: true }; }
      case 'maker:list-active': { const sessions = [...this.live.values()].map(({ session }) => ({ sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir, capabilities: session.capabilities, isTurnRunning: session.isTurnRunning() })); return args[0] && record(args[0]).snapshotVersion === 2 ? { format: 'active-sessions-v2', sessions } : sessions; }
      case 'maker:any-session-in-turn': return [...this.live.values()].some(task => task.session.isTurnRunning());
      case 'maker:session:turn-active': return { inTurn: this.isTurnRunning(string(args[0])) };
      case 'maker:session-in-turn': return this.live.get(string(args[0]))?.session.isTurnRunning() ?? false;
      case 'maker:plugin-setup:submit-inline': {if(context.source!=='local')throw new Error('LOCAL_ONLY_COMMAND');const request=parseGhostSetupInlineSubmitRequest(args[0]);return {accepted:Boolean(request&&this.pluginSetup?.bridge.submitInline(request.requestId,request))};}
      case 'maker:get-pending-interactions': return [...(!context.sharedTask?this.pluginSetup?.bridge.pendingSnapshots(string(args[0]))??[]:[]),...(!context.sharedTask ? this.options.protectedInput?.handoff.pendingSnapshots(string(args[0]))??[] : []), ...[...this.pending.values()].filter(p => p.sessionId === args[0] && !p.migrated && (!context.sharedTask || ['permission','ask_user_question','plan_review'].includes(p.request.kind))).map(p => ({ request: p.request }))];
      case 'maker:resolve-interaction': {if(!context.sharedTask&&this.pluginSetup?.bridge.pendingSnapshots().some(item=>item.request.requestId===args[0]))return {accepted:this.pluginSetup.bridge.resolve(string(args[0]),args[1])};if(!context.sharedTask&&this.options.protectedInput?.handoff.isCurrent(string(args[0])))return this.options.protectedInput.handoff.resolve(string(args[0]),args[1],context.source==='remote'?{deviceId:context.deviceId}:{local:true});if(context.sharedTask)this.assertSharedInteraction(string(args[0]),record(args[1]));return this.resolveInteraction(string(args[0]), args[1]);}
      case 'maker:close-session': { const id = string(args[0]); await this.cancelTaskRecovery(id); if (this.starts.has(id)) throw new Error('TASK_STARTING'); await this.closeTask(id); return { success: true }; }
      case 'maker:abort-session': { const id=string(args[0]);await this.cancelTaskRecovery(id);this.options.protectedInput?.handoff.cleanupForSession(id);this.pluginSetup?.bridge.cleanupForSession(id,'session_aborted');const task = this.live.get(id); if(task)await this.turnLifecycle.stop(task.session); return { success: true }; }
      case 'maker:send': {
        if (this.stoppingTasks.has(string(args[0]))) throw new Error('SESSION_STOPPING');
        if (args[1] && typeof args[1] === 'object' && typeof (args[1] as Record<string, unknown>).clientId === 'string') {
          const receipt = await this.submit(string(args[0]), args[1], { requestId: (args[1] as Record<string, unknown>).clientId }, context);
          return { accepted: !['failed', 'interrupted'].includes(receipt.status), requestId: receipt.requestId, clientId: receipt.requestId, status: receipt.status, ...(receipt.error ? { reason: receipt.error } : {}) };
        }
        const id = string(args[0]);
        if (this.persistenceFaults.has(id)) throw new Error('TASK_HISTORY_WRITE_FAILED');
        if (this.sending.has(id) || this.turnLifecycle.running(id) || this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
        const message = await this.message(id, args[1], context);
        const releaseRoute = await this.routes.acquireForSend(id);
        try {
          // Parsing attachments and waiting for the route lane can outlive
          // another accepted turn. Recheck before appending a visible user row.
          if (this.sending.has(id) || this.turnLifecycle.running(id) || this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
          this.sending.add(id);
          const task = await this.ensureLive(id);
          this.guard(context);
          if(context.deliveryProof){await validateTaskDelivery(this.options.remoteInvoke,context.deliveryProof);this.guard(context);}
          if(context.plugin){if(!this.pluginSessions)throw new Error('PLUGIN_TASKS_UNAVAILABLE');await this.pluginSessions.assertDispatch(context.plugin.id,id);this.guard(context);}
          if (context.targetPlugin) { await this.assertPluginTargetInput(id, this.activeSubmissions.get(id)); this.guard(context); }
          if (context.orca) { await assertRemoteWorkerAssignment(this.storage, id, context.orca); this.guard(context); }
          if (context.collaboration) { await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration); this.guard(context); }
          const agentMeta = context.collaboration ? { origin: context.collaboration.origin } : context.orca ? { origin: context.orca.origin } : context.plugin || context.targetPlugin ? {sourcePlugin:{pluginId:(context.plugin ?? context.targetPlugin)!.id,name:(context.plugin ?? context.targetPlugin)!.name}} : context.deliveryProof ? {origin:{kind:'session' as const,senderSessionId:`${context.deliveryProof.controllerDeviceId}::${context.deliveryProof.sessionId}`,senderSessionTitle:context.deliveryProof.senderTitle,displayText:context.deliveryProof.message}} : context.sender ? {origin:{kind:'session' as const,senderSessionId:context.sender.sessionId,senderSessionTitle:context.sender.title,displayText:inputPlainText(message)}} : context.scheduler ? { origin: context.scheduler } : context.sharedTask ? { sharedTaskAuthor: { memberId: context.sharedTask.memberId, accountId: context.sharedTask.accountId, displayName: context.sharedTask.name ?? context.sharedTask.memberId } } : context.source === 'remote' && context.sourceDevice ? { sourceDevice: context.sourceDevice } : undefined;
          const projection=createAutoReviewIntentProjection();
          const authoredText=projection.readText(persistedInput(message))??'';
          const authorityMeta={...agentMeta,delivery:'turn',autoReviewUserText:context.scheduler?{kind:'scheduled-continuation'}:context.collaboration||context.orca||context.plugin||context.targetPlugin||context.sender||context.deliveryProof||context.sharedTask?{kind:'delegated-continuation'}:authoredText};
          this.changes.assertCanDispatch(task.session.workDir);
          const historyMessage = terminalOrcaHistoryMessage(message, context.collaboration);
          const stored=await this.storage.append(id, { kind: 'user', message: historyMessage, clientId: this.activeSubmissions.get(id) ?? randomUUID(), origin: context.source, agentMeta:authorityMeta });
          this.emit('local-db:messages:created',{sessionId:id,message:{id:`${id}:${stored.sequence}`,clientId:stored.clientId??`${id}:${stored.sequence}`,sessionId:id,role:'user',content:persistedInput(historyMessage),createdAt:new Date(stored.timestamp).toISOString(),agentKind:task.selection.agentKind==='claude-code'?'cc':task.selection.agentKind,agentMeta:authorityMeta}});
          this.guard(context);
          const payload = context.scheduler ? appendInputText(message, `[Scheduled run context]\nschedule: ${JSON.stringify(context.scheduler.scheduleName)} (schedule_id: ${context.scheduler.scheduleId})\nrun_id: ${context.scheduler.runId}\nfiredAtUtc: ${new Date(context.scheduler.firedAt??Date.now()).toISOString()}`) : agentMeta ? appendInputText(message, 'sourceDevice' in agentMeta && agentMeta.sourceDevice ? buildClientDeviceNote(agentMeta.sourceDevice) : buildMessageSourceNote(messageSourceSenderFromMeta(agentMeta)) ?? '') : message;
          let changeSetStarted = false;
          let restoredOrcaReport = false;
          try {
            const outgoing = await this.taskContext.prepareHandoff(id, payload);
            const history=await this.contextMessages(id,Infinity);
            const intent=projection.restore(history.map(message=>({...message,agentMeta:message.agentMeta??null})),context.collaboration||context.orca||context.plugin||context.targetPlugin||context.scheduler||context.sender||context.deliveryProof?undefined:{clientId:stored.clientId!,content:persistedInput(message),authoredText});
            this.guard(context);
            const result = await this.channelSignals.withChannelTurnSource(id, this.channelSignals.channelTurnSourceFor(agentMeta?.origin, false), () => task.session.send(outgoing.message, {
              ...(context.scheduler ? { origin: context.scheduler } : {}),
              [AUTO_REVIEW_SOURCE_CONTENT]:message.content,
              [AUTO_REVIEW_USER_INTENT]:intent,
              ...(context.sharedTask?{turnPermissionPolicy:{origin:{kind:'desktop' as const},confirmationSurface:'desktop' as const,autoReviewContext:{requesterAuthority:'guest' as const,source:'group' as const},forceConfirmToolCall:()=>false}}:{}),
              onAccepted: async () => {
                this.guard(context);
                if (context.targetPlugin) await this.assertPluginTargetInput(id, stored.clientId);
                if (context.orca) await assertRemoteWorkerAssignment(this.storage, id, context.orca);
                if (context.collaboration) await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration);
                if(context.plugin){if(!this.pluginSessions)throw new Error('PLUGIN_TASKS_UNAVAILABLE');await this.pluginSessions.accept(context.plugin.id,id,stored.clientId!,{instanceId:task.session.instanceId,generation:task.session.getTurnGeneration()});this.guard(context);}
                this.turnLifecycle.noteUserSend(id);
                await this.changes.begin(task.session, stored.clientId!);
                changeSetStarted = true;
                if (context.collaboration) {
                  await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration);
                  if (context.collaboration.source === 'lead') await this.orcaReports.begin(id, stored.clientId!);
                  const accepted = this.orcaDispatcher.runQueuedOrcaInterAgentAcceptedCallback(id, { clientId: stored.clientId! });
                  if (accepted) await accepted;
                  else if (context.collaboration.source === 'lead' && this.orcaTeamService) {
                    // Callback closures cannot survive a process restart. The
                    // durable assignment restores the shared service's report ownership.
                    this.orcaTeamService.restoreWorkerPendingReport(id, context.collaboration);
                    restoredOrcaReport = true;
                  }
                  await this.orcaTeamService?.handleWorkerTurnStarted(id);
                }
                this.guard(context);
                if (context.orca) this.remoteWorkerTurns.set(id, { instanceId: task.session.instanceId, generation: task.session.getTurnGeneration(), clientId: stored.clientId! });
                else this.remoteWorkerTurns.delete(id);
              },
            }));
            if (context.collaboration) {
              await this.orcaDispatcher.settleQueuedOrcaInterAgentAcceptedCallback(id,
                { persistUserMessage: { clientId: stored.clientId!, content: persistedInput(historyMessage), delivery: 'turn' } },
                toDesktopSessionDispatchOutcome(result, { source: 'orca', context: 'terminal-durable-input' }));
              if (!result.accepted) await this.orcaReports.suppress(id, stored.clientId);
              if (!result.accepted && restoredOrcaReport) this.orcaTeamService?.clearAutoBridgeState(id);
            }
            if (result.accepted) outgoing.accepted();
            if (!result.accepted && changeSetStarted) this.changes.store.clearPendingTurnChangeSets(id);
            return result;
          } catch (error) {
            if (context.collaboration) {
              await this.orcaReports.suppress(id, stored.clientId);
              await this.orcaDispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback(id, stored.clientId);
              if (restoredOrcaReport) this.orcaTeamService?.clearAutoBridgeState(id);
            }
            if (changeSetStarted) this.changes.store.clearPendingTurnChangeSets(id); throw error;
          }
        } finally { this.sending.delete(id); releaseRoute(); }
      }
      case 'maker:steer': {const id=string(args[0]),session=(await this.ensureLive(id)).session;noteInteractionRouteSteer(session);return session.steer(typeof args[1] === 'string' ? args[1] : await this.message(id, args[1], context),{beforeProviderStart:()=>{this.guard(context);this.remoteWorkerTurns.delete(id);}});}
      case 'maker:get-context-usage': return (await this.ensureLive(string(args[0]))).session.getContextUsage();
      case 'maker:get-session-agent-switch-intent': return this.routes.intent(string(args[0]));
      case 'maker:switch-session-agent': {
        const opts = args[6] === undefined ? {} : record(args[6]);
        if (context.source === 'remote' && opts.confirmedContextWindow !== undefined) throw new Error('PRECONDITION_FAILED');
        if (context.sharedTask && opts.agentDeviceId !== undefined) throw new Error('UNSUPPORTED_CAPABILITY');
        return this.routes.select({ sessionId: args[0], targetAgentKind: args[1], model: args[2], providerId: args[3], effort: args[4], fastMode: args[5], thinking: args[7], ...(opts.agentDeviceId !== undefined ? { agentDeviceId: opts.agentDeviceId } : {}), ...(opts.confirmedContextWindow !== undefined ? { confirmedContextWindow: opts.confirmedContextWindow } : {}), assertSelectionCurrent: () => this.guard(context) });
      }
      case 'maker:set-model': {
        const terminalOptions = args[2] && typeof args[2] === 'object' ? record(args[2]) : undefined;
        const opts = terminalOptions ?? (args[4] === undefined ? {} : record(args[4]));
        if (context.source === 'remote' && opts.confirmedContextWindow !== undefined) throw new Error('PRECONDITION_FAILED');
        return this.routes.selectModel(string(args[0]), string(args[1]), terminalOptions ? opts.providerId : args[2], opts, args[3], () => this.guard(context));
      }
      case 'maker:set-effort': { const task = await this.ensureLive(string(args[0])); const selection = { ...task.selection, effort: args[1] }; const chosen = await this.models.select(selection); await task.session.setEffort(chosen.selection.effort!); task.selection = chosen.selection; await this.storage.setSelection(task.session.id, chosen.selection); return { success: true }; }
      case 'maker:set-permission-mode': {
        const task = await this.ensureLive(string(args[0])), mode = permission(args[1]);
        const result = await this.changeChannelPermission({ sessionId: task.session.id, mode, modes: task.session.capabilities.permissionModes, confirmedFullAccess: true,
          readPreviousMode: async () => { const row = await this.storage.get(task.session.id); return row ? permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask') : null; },
          getLiveSession: () => this.live.get(task.session.id)?.session ?? null,
          persist: async value => { this.guard(context); await this.storage.update(task.session.id, { permissionMode: value }); this.guard(context); },
        });
        if (result.kind !== 'changed') throw new Error(result.kind === 'failed' || result.kind === 'invalid' ? result.reason : 'PERMISSION_CONFIRMATION_REQUIRED');
        return { success: true };
      }
      case 'maker:get-plugin-write-access-recovery': case 'maker:retry-plugin-write-access': {
        if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');
        if(!this.pluginSessions)return {granted:false,available:false};
        return this.pluginSessions.recoverWriteAccess(string(args[0]),channel==='maker:retry-plugin-write-access',()=>this.guard(context));
      }
      case 'maker:set-plan-mode': {
        if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');
        const id=string(args[0]),enabled=args[1];
        return this.permissionChanges.withSessionPermissionChange(id,async()=>{
          this.guard(context);const task=await this.ensureLive(id);this.guard(context);
          await task.session.setPlanMode(enabled);this.guard(context);
          await this.storage.update(id,{planMode:enabled});return {success:true};
        });
      }
      case 'maker:set-fast-mode': { if (typeof args[1] !== 'boolean' && args[1] !== 'ultrafast') throw new Error('INVALID_ARGUMENT'); const task = await this.ensureLive(string(args[0])); await task.session.setFastMode(args[1]); await this.storage.update(task.session.id, { fastMode: args[1] }); return { success: true }; }
      case 'maker:compact-session': return (await this.ensureLive(string(args[0]))).session.compactSession(typeof args[1] === 'string' ? args[1] : undefined);
      case 'maker:list-available-agents': return ENGINES.filter(kind => Boolean(this.binaries.get(kind)));
      case 'maker:agent:status': { const kind = string(args[0]) as AgentKind; if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE'); const binary = this.binaries.get(kind) ?? null; const auth = await this.authState(kind); return { binaryReady: Boolean(binary), binaryPath: binary, authReady: auth.authenticated, ...auth }; }
      case 'maker:auxiliary-model-settings:get': return this.utility.state();
      case 'maker:auxiliary-model-settings:set': return this.utility.update(args[0], () => this.guard(context));
      case 'maker:provider:list': return this.models.views();
      case 'maker:provider:presets': return {presets:this.models.presets()};
      case 'maker:provider:test-connection': return testConnection(this.models,args[0],()=>this.guard(context),context.signal);
      case 'maker:provider:models-fetch': return fetchModels(this.models,args[0],()=>this.guard(context),context.signal);
      case 'maker:provider:models-refresh': case 'maker:provider:models-rediscover': {const result=await this.models.refresh(string(args[0]));this.emit('maker:provider:changed',{});return result;}
      case 'maker:provider:models-auto-refresh': {if(!['providers-open','model-selector-open'].includes(string(args[0])))throw new Error('INVALID_REFRESH_TRIGGER');await this.models.views();return {ok:true};}
      case 'maker:provider:custom:disconnect': await this.models.disconnect(string(args[0]),()=>this.guard(context));this.emit('maker:provider:changed',{});return {ok:true};
      case 'maker:model-disable:set': await this.models.setDisabled(args[0],()=>this.guard(context));this.emit('maker:provider:changed',{});return {ok:true};
      case 'terminal:models:get': return this.models.snapshot();
      case 'terminal:models:set-default': await this.models.setDefault(args[0], () => this.guard(context)); return this.models.snapshot();
      case 'terminal:models:reset-default': await this.models.resetDefault(() => this.guard(context)); return this.models.snapshot();
      case 'maker:provider:custom:create': case 'maker:provider:custom:update': return this.configureProvider(channel.endsWith(':create')?'create':'edit',args[0],args[1]??{},context);
      case 'maker:provider:custom:delete': await this.models.deleteProvider(string(args[0]), () => this.guard(context)); this.emit('maker:provider:changed', {}); return { success: true };
      default: throw new Error(`UNSUPPORTED_CHANNEL:${channel}`);
    }
  }
  private async updateReceipt(id: string, requestId: string, status: Submission['status'], error?: string, finalText?: string) {
    try {
      const receipt = await this.storage.updateSubmission(id, requestId, status, error, finalText);
      if(receipt.plugin)await this.pluginSessions?.onSubmission(receipt);
      this.emit('terminal:tasks:submission', receipt);
      for (const listener of this.receiptListeners) listener(receipt);
      if(receipt.deliveryProof && ['completed','failed','interrupted'].includes(receipt.status))void validateTaskDelivery(this.options.remoteInvoke,receipt.deliveryProof,true).catch(()=>undefined);
      return receipt;
    } catch { this.options.logger.error('Terminal submission persistence failed'); return null; }
  }
  private receiptView(receipt: Submission) {
    const pendingRequests = [...this.pending.values()].filter(item => item.sessionId === receipt.sessionId).map(item => item.request);
    return { ...receipt, clientId: receipt.requestId, status: pendingRequests.length && ['running', 'sending'].includes(receipt.status) ? 'waiting' : receipt.status === 'sending' ? 'running' : receipt.status, errorCode: receipt.error ?? null, finalText: receipt.finalText ?? (this.activeSubmissions.get(receipt.sessionId) === receipt.requestId ? this.submissionText.get(receipt.sessionId) : '') ?? '', pendingRequests };
  }
  private async submit(id: string, input: unknown, options: Record<string, unknown>, context: TaskInvocationContext, atHead = false) {
    const lifecycle: AttachmentLifecycle = {cleanup:[],accepted:[]};
    try {
    const message = await this.message(id, input, context, lifecycle);
    const requestId = options.requestId === undefined ? randomUUID() : string(options.requestId);
    if (!(context.plugin ? /^plugin-task:[a-zA-Z0-9_-]{1,100}$/ : context.targetPlugin ? /^plugin-target:[a-zA-Z0-9_-]{1,100}$/ : /^[a-zA-Z0-9_-]{1,100}$/).test(requestId)) throw new Error('INVALID_REQUEST_ID');
    const sendAtMs = options.sendAtMs === undefined ? undefined : Number(options.sendAtMs);
    if (sendAtMs !== undefined && (!Number.isFinite(sendAtMs) || sendAtMs < 0)) throw new Error('INVALID_SEND_TIME');
    const fingerprint = createHash('sha256').update(JSON.stringify({ message, memberId: context.sharedTask?.memberId, pluginId:context.plugin?.id, targetPlugin:context.targetPlugin, orca:context.orca, collaboration:context.collaboration, sendAtMs })).digest('hex');
    const claimed = await this.permissionChanges.withSessionPermissionChange(id,()=>this.storage.claimSubmission(id, requestId, fingerprint, () => this.guard(context), { message, source: context.source, deviceId: context.deviceId, sourceDevice: context.sourceDevice, ownerId: context.ownerId, sharedTask: context.sharedTask, scheduler: context.scheduler, sender:context.sender, plugin:context.plugin, targetPlugin:context.targetPlugin, orca:context.orca, collaboration:context.collaboration, deliveryProof:context.deliveryProof, sendAtMs }, atHead));
    for(const accepted of lifecycle.accepted) await accepted().catch(()=>this.options.logger.warn('ATTACHMENT_RELAY_CLEANUP_FAILED'));
    if (!claimed.created) return claimed.receipt;
    // Acceptance is durable before work begins; reconnecting with the same key
    // returns the original receipt, including after a process restart.
    this.enqueueSubmission(id, message, requestId, { ...context, signal: undefined }, sendAtMs, atHead);
    return claimed.receipt;
    } finally { await Promise.allSettled(lifecycle.cleanup.map(cleanup=>cleanup())); }
  }
  private enqueueSubmission(id: string, message: UserMessage, requestId: string, context: TaskInvocationContext, sendAtMs?: number, atHead = false) {
    const queue = this.queuedSubmissions.get(id) ?? [];
    if (!queue.some(item => item.requestId === requestId)) queue.splice(atHead ? 0 : queue.length, 0, { message, requestId, context, sendAtMs });
    this.queuedSubmissions.set(id, queue);
    setImmediate(() => this.drain(id));
    void this.projection(id).then(projection => this.emit('maker:input:projection', projection)).catch(() => undefined);
  }
  private drain(id: string) {
    if (!this.pendingDispatchReady || this.closed || this.stoppingTasks.has(id) || this.recovering.has(id) || this.queuePaused.has(id) || this.queueMutations.has(id) || this.steeringSubmissions.has(id) || this.queueLocks.get(id)?.size || this.queueEditLocks.get(id)?.size || this.activeSubmissions.has(id) || this.starts.has(id) || this.sending.has(id) || this.turnLifecycle.running(id) || this.live.get(id)?.session.isTurnRunning()) return;
    const queue = this.queuedSubmissions.get(id) ?? [];
    const readyIndex = queue.findIndex(item => !item.sendAtMs || item.sendAtMs <= Date.now());
    const next = readyIndex >= 0 ? queue.splice(readyIndex,1)[0] : undefined;
    const timer = this.queueTimers.get(id); if (timer) clearTimeout(timer); this.queueTimers.delete(id);
    if (!next && queue.length) { const delay = Math.min(...queue.map(item => item.sendAtMs ?? Date.now())) - Date.now(); const pending = setTimeout(()=>{this.queueTimers.delete(id);this.drain(id);},Math.min(2_147_483_647, Math.max(1, delay))); pending.unref(); this.queueTimers.set(id,pending); }
    if (next) void this.runSubmission(id, next.message, next.requestId, next.context);
  }
  private async requireQueued(id:string,clientId:string,context:TaskInvocationContext){
    const receipt=await this.storage.submission(id,clientId);if(!receipt||receipt.status!=='queued'||(this.activeSubmissions.get(id)===clientId||this.steeringSubmissions.get(id)?.clientId===clientId))throw new Error('QUEUED_MESSAGE_NOT_FOUND');
    if(context.sharedTask&&receipt.sharedTask?.memberId!==context.sharedTask.memberId)throw new Error('SHARED_TASK_INPUT_NOT_OWNED');return receipt;
  }
  private async removeQueued(id:string,clientId:string,context:TaskInvocationContext){
    await this.mutateQueued(id,async()=>{await this.requireQueued(id,clientId,context);
      const receipt=await this.storage.editQueuedSubmission(id,clientId,{status:'interrupted',error:'INPUT_REMOVED'},()=>this.guard(context));this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(clientId);if(receipt.plugin)await this.pluginSessions?.onSubmission(receipt);this.emit('terminal:tasks:submission',receipt);for(const listener of this.receiptListeners)listener(receipt);const queue=this.queuedSubmissions.get(id);const index=queue?.findIndex(item=>item.requestId===clientId)??-1;if(index>=0)queue!.splice(index,1);
    });
  }
  private async projection(id: string, options: Record<string, unknown> = {}) {
    const requested = options.deliveryClientIds;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 100 || requested.some(id => typeof id !== 'string' || id.length > 100))) throw new Error('INVALID_DELIVERY_CLIENT_IDS');
    const deliveryReceipts = Array.isArray(requested) ? await Promise.all([...new Set(requested as string[])].map(async clientId => {
      const receipt = await this.storage.submission(id, clientId);
      if (!receipt) return { clientId, state: 'unknown' as const };
      const view = this.receiptView(receipt);
      return { clientId, state: receipt.error === 'INPUT_REMOVED' ? 'removed' as const : receipt.status === 'queued' ? 'pending' as const : 'accepted' as const,
        turnStatus: view.status, finalText: view.finalText, errorCode: view.errorCode, pendingRequests: view.pendingRequests };
    })) : undefined;
    const row = await this.storage.get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const persisted = await this.storage.queued(id);
    const order = this.queuedSubmissions.get(id)??[];const queued = [...persisted].sort((a,b)=>order.findIndex(item=>item.requestId===a.requestId)-order.findIndex(item=>item.requestId===b.requestId));
    return { sessionId: id, terminalTurnReceiptsVersion: 1, ...(deliveryReceipts ? {deliveryReceipts} : {}), turnInProgress: this.activeSubmissions.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning() === true,
      pendingQueue: queued.map(item => ({ clientId: item.requestId, ...(item.targetPlugin ? { sourcePlugin: { pluginId: item.targetPlugin.id, name: item.targetPlugin.name } } : {}), ...(item.collaboration || item.orca ? { origin: item.collaboration?.origin ?? item.orca?.origin } : {}), ...(item.sendAtMs ? {sendAtMs:item.sendAtMs} : {}), text: inputPlainText(item.message), persistedContent: item.message ? persistedInput(terminalOrcaHistoryMessage(item.message, item.collaboration)) : '', model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'default', workingDir: row.workDir,
        chatMessage: { clientId: item.requestId, role: 'user', content: item.message ? persistedInput(terminalOrcaHistoryMessage(item.message, item.collaboration)) : '', createdAt: new Date(item.createdAt).toISOString() },
        createOpts: { agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId },
      })), steeringQueueClientIds: this.steeringSubmissions.has(id) ? [this.steeringSubmissions.get(id)!.clientId] : [], queuePaused: this.queuePaused.has(id), queueExpanded: row.queueExpanded!==false, queueInteractionLocks: [...(this.queueLocks.get(id)??[])], queueEditLocks: [...(this.queueEditLocks.get(id)??[])], queueAbortPending: false, error: null, errorReason: null, recovery: null, errorRetryText: null, credentialSwitchWait: null };
  }
  private async runSubmission(id: string, message: UserMessage, requestId: string, context: TaskInvocationContext) {
    try {
      this.guard(context);
      if (this.activeSubmissions.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning()) throw new Error('SESSION_RUNNING');
      this.activeSubmissions.set(id, requestId);
      // These dispatchers own their retry and source metadata. Generic replay
      // deliberately leaves them alone, including task-to-task inputs whose
      // source is persisted but is not a Maker SendOrigin.
      if (context.collaboration || context.orca || context.plugin || context.targetPlugin || context.scheduler || context.sender || context.deliveryProof) this.externalSubmissions.set(id, requestId);
      else this.externalSubmissions.delete(id);
      if (!await this.updateReceipt(id, requestId, 'sending')) throw new Error('SUBMISSION_PERSISTENCE_FAILED');
      const result = await this.invoke('maker:send', [id, message], {...context, normalizedInput:true}) as { accepted: boolean; reason?: string };
      if (!result.accepted) throw new Error(result.reason ?? 'SEND_REJECTED');
      await this.updateReceipt(id, requestId, 'running');
      void this.projection(id).then(projection => this.emit('maker:input:projection', projection)).catch(() => undefined);
      setImmediate(() => this.drain(id));
    } catch (error) {
      if (this.activeSubmissions.get(id) === requestId) { this.activeSubmissions.delete(id); this.externalSubmissions.delete(id); }
      const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SEND_FAILED';
      await this.updateReceipt(id, requestId, 'failed', reason);
      this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(requestId);
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
  private async message(id: string, value: unknown, context: TaskInvocationContext, lifecycle?: AttachmentLifecycle): Promise<UserMessage> {
    if (context.normalizedInput) return value as UserMessage;
    const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
    return normalizeTaskInput({...this.options, ingestAttachment: this.options.ingestAttachment ?? ((input,ctx)=>this.media.ingest(input,()=>this.guard(ctx))), resolveAttachment: async (reference,ctx,sid) => reference.startsWith('cindy-media://') ? this.media.resolveManaged(reference,ctx.sharedTask ? sid : undefined) : this.options.resolveAttachment ? this.options.resolveAttachment(reference,ctx,sid) : Promise.reject(new Error('ATTACHMENT_RESOLVER_REQUIRED'))},id,value,context,row.workDir,()=>this.guard(context),lifecycle);
  }
  private historyView() {
    return createHistoryViewReader({
      list:(id,options)=>this.messages(id,{...options}),
      running:id=>this.isTurnRunning(id),
      anchor:async(id,key)=>{const row=(await this.messages(id,{limit:Infinity},true)).find(row=>row.id===key);if(!row)throw new Error('MESSAGE_NOT_FOUND');return row;},
    });
  }
  private async messages(id: string, options: Record<string, unknown>, internal = false) {
    const limit = typeof options.limit === 'number' ? Math.max(1, Math.min(internal ? Infinity : 1000, options.limit)) : 200;
    const beforeSequence = options.before ? Number(string(options.before).split(':').at(-1)) : Infinity;
    const afterSequence = options.after ? Number(string(options.after).split(':').at(-1)) : -1;
    if (Number.isNaN(beforeSequence) || Number.isNaN(afterSequence)) throw new Error('INVALID_MESSAGE_CURSOR');
    const result: Array<{ id: string; rowid?: number; clientId: string; sessionId: string; role: string; content: string; createdAt: string; agentKind: string | null; agentMeta: Record<string, unknown> | null }> = [];
    const add = (message: typeof result[number]) => {
      const sequence = Number(message.id.split(':').at(-1));message.rowid=sequence;
      if(options.after&&result.length>=limit)return;
      if (sequence < beforeSequence && sequence > afterSequence && (!options.beforeTs || Date.parse(message.createdAt) < Number(options.beforeTs))) { result.push(message); if (result.length > limit) result.shift(); }
    };
    const task = await this.storage.get(id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    let after = 0;
    let assistant: typeof result[number] | undefined;
    do {
      const page = await this.storage.history(id, after, 1000);
      for (const row of page.records) {
        if (row.timestamp <= (task.clearedAt ?? 0)) continue;
        if (row.kind === 'user-meta') {
          const message = result.find(message => message.clientId === row.clientId && message.role === 'user');
          if (message) message.agentMeta = { ...message.agentMeta, ...row.agentMeta };
          continue;
        }
        if (row.kind === 'boundary-meta') {
          const boundary = result.find(message => message.clientId === row.clientId && message.role === 'agent_switch');
          if (boundary && row.boundary) boundary.content = JSON.stringify(row.boundary);
          continue;
        }
        if (row.kind === 'boundary' && row.boundary) {
          assistant = undefined;
          add({ id: `${id}:${row.sequence}`, clientId: row.clientId!, sessionId: id, role: 'agent_switch', content: JSON.stringify(row.boundary), createdAt: new Date(row.timestamp).toISOString(), agentKind: row.boundary.toAgentKind, agentMeta: null });
          continue;
        }
        if (row.kind === 'context-rebuild' && row.contextRebuild) {
          assistant = undefined;
          const common = { clientId: row.clientId!, sessionId: id, createdAt: new Date(row.timestamp).toISOString(), agentKind: row.contextRebuild.sourceAgentKind ?? (task.agentKind === 'claude-code' ? 'cc' : task.agentKind), agentMeta: { contextRebuild: row.contextRebuild } };
          if (internal) add({ ...common, id: `${id}:${row.sequence}`, role: 'context_rebuild', content: row.contextRebuild.handoff });
          add({ ...common, id: `${id}:rebuild:${row.sequence}`, clientId: `${row.clientId}:card`, role: 'assistant', content: '' });
          continue;
        }
        if (row.kind === 'user' && row.message) {
          assistant = undefined;
          const content = persistedInput(row.message);
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
        } else if (row.event?.type === 'done') {if(assistant)assistant.agentMeta={...assistant.agentMeta,turnCompleted:true};assistant = undefined;}
      }
      if (!page.hasMore) break;
      after = page.nextCursor;
    } while (true);
    return result.reverse();
  }
  historyDeps(): import('../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js').XdtHelperHistoryDeps {
    type Cursor = { id: string; createdAt: number };
    const page = <T extends Cursor>(items: T[], limit: number, order: 'asc' | 'desc', cursor: Cursor | null) => {
      const direction = order === 'asc' ? 1 : -1;
      const sorted = items.sort((a, b) => direction * (a.createdAt - b.createdAt || a.id.localeCompare(b.id))).filter(item => !cursor || direction * (item.createdAt - cursor.createdAt || item.id.localeCompare(cursor.id)) > 0);
      const selected = sorted.slice(0, limit);
      const last = selected.at(-1);
      return { items: selected, hasMore: sorted.length > limit, nextCursor: sorted.length > limit && last ? { id: last.id, createdAt: last.createdAt } : null };
    };
    const sessions = async (scope: string[] | null, includeDeleted = false) => (await this.storage.list()).filter(row => (!row.hiddenAt || scope?.includes(row.id)) && (includeDeleted || !row.deleted) && (scope === null || scope.includes(row.id)));
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
      listSessions: async args => ({ ok: true, page: page((await sessions(args.sessionIds, args.includeDeleted)).filter(row => (args.includeDeleted || !row.deleted) && (!args.workdir || row.workDir === args.workdir) && (!args.agentKind || (row.agentKind === 'claude-code' ? 'cc' : row.agentKind) === args.agentKind) && (args.fromMs === null || row.createdAt >= args.fromMs) && (args.toMs === null || row.createdAt <= args.toMs)).map(row => ({ id: row.id, title: row.title, workingDir: row.workDir, agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind, workspaceKind: 'local', model: row.model, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', source: 'local', orcaRole: row.orcaRole ?? null, parentSessionId: row.parentSessionId ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt, userSendAt: null, messageCount: 0 })), args.limit, args.order, args.cursor) }),
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
  private async patchMeta(id: string, patch: Record<string, unknown>, guard:()=>void=()=>{}) {
    if (Object.keys(patch).some(key => !['title', 'status', 'pinnedAt'].includes(key))) throw new Error('UNSUPPORTED_SESSION_PATCH_FIELD');
    const update: Partial<TerminalTaskMeta> = {};
    if (patch.title !== undefined) update.title = string(patch.title);
    if (patch.status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(String(patch.status))) throw new Error('INVALID_SESSION_STATUS');
      if (patch.status !== 'active' && (this.starts.has(id) || this.sending.has(id) || this.live.get(id)?.session.isTurnRunning())) throw new Error('SESSION_RUNNING');
      update.archived = patch.status === 'archived'; update.deleted = patch.status === 'deleted';
      if (patch.status !== 'active') { await this.cancelTaskRecovery(id); await this.options.beforeTaskUnavailable?.(id); guard(); await this.closeTask(id); }
    }
    if (patch.pinnedAt !== undefined) {
      const at = patch.pinnedAt === null ? null : typeof patch.pinnedAt === 'number' ? patch.pinnedAt : Date.parse(string(patch.pinnedAt));
      if (at !== null && !Number.isFinite(at)) throw new Error('INVALID_PINNED_TIMESTAMP');
      update.pinnedAt = at;
    }
    guard();const row = await this.storage.update(id, update);
    this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    return this.guiSession(row);
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    this.closed = true;
    this.orcaIdle.stop();
    this.orcaRemoteController.stop();
    await this.orcaReports.close();
    this.utilityAbort.abort();
    await this.utility.close();
    const recovery = [...this.recovering.keys()].map(id => this.cancelTaskRecovery(id));
    const channelHandlers = this.channelControl.close();
    await this.channelOrchestrators.close();
    await channelHandlers;
    this.turnLifecycle.close();
    for (const timer of this.queueTimers.values()) clearTimeout(timer); this.queueTimers.clear();
    // Initializers have all settled even when one failed. Close the stores and
    // native handles that did open; the start caller retains the original error.
    await this.ready.catch(()=>{});
    await Promise.allSettled(this.utilityWork);
    await Promise.allSettled(recovery);
    await Promise.allSettled(this.starts.values());
    for (const boundary of this.steeringSubmissions.values()) boundary.controller.abort();
    await Promise.allSettled(this.steerOperations);
    await Promise.all([...this.live.keys()].map(id => this.closeTask(id)));
    this.makerObservers.clear();
    this.channelVendorOptions.clear();
    this.channelHydration.clear();
    await this.taskContext.close();
    await this.orcaStore.close();
    await this.channelBindings.close();
    await this.channelDefaults.close();
    await this.capabilities.close();
    await Promise.allSettled([...this.hosted].map(handle => handle.close()));
    await Promise.all([this.storage.flush(), this.models.flush(), this.media.close(), this.changes.close()]);
  }
}
