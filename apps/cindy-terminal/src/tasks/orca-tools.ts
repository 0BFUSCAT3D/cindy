import type { McpProvider, McpProviderContext, Session, AgentKind } from '@cindy/maker-core';
import { createOrcaMcpServer, type OrcaMcpDeps } from '../../../../packages/lizi-mcps/src/orca/server.js';
import { getOrcaWorkspaceInfoReadOnly, getOrcaWorkerDiagnosticStatusReadOnly, readOrcaWorkerOutputReadOnly, type OrcaDiagnosticsDeps } from '@cindy/orca-workflow/host/orcaDiagnostics';
import { findFocusTargetWorker, type OrcaTeamService } from '@cindy/orca-workflow/host/orcaTeamService';
import type { OrcaLifecycleService } from '@cindy/orca-workflow/host/orcaLifecycleService';
import type { OrcaRemoteWorkers } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
import { deviceAvailableModels } from '@cindy/orca-workflow/host/orcaProviderRoutingContext';
import type { ProviderView } from '@cindy/model-providers';
import type { TerminalOrcaStore } from './orca-store.js';
import type { TerminalTaskStorage } from './storage.js';

export function createTerminalOrcaTools(deps: {
  store: TerminalOrcaStore; tasks: TerminalTaskStorage; lifecycle: OrcaLifecycleService; team: OrcaTeamService;
  remote: OrcaRemoteWorkers;
  selfDeviceId?: string;
  providers(deviceId: string | null): Promise<ProviderView[]>;
  locations(): Promise<Array<{ agentDeviceId: string; name: string }>>;
  authorize(ctx: McpProviderContext): NonNullable<OrcaMcpDeps['authorizeCall']>;
  authority(id: string): Promise<{ assertCurrent(): Promise<void> }>;
  live(id: string): Session | undefined;
  resume(id: string, current: () => Promise<void>): Promise<void>;
  end(id: string): Promise<void>;
  latestText(id: string): Promise<string>;
  running(id: string): boolean;
  paused(id: string): boolean;
  changed(id: string): void;
  warn(error: unknown): void;
}) {
  const diagnostics: OrcaDiagnosticsDeps = {
    readActiveTeam: id => deps.store.getActiveTeamByLead(id),
    listWorkersByLead: id => deps.store.listWorkersByLead(id),
    getSessionStatus: id => deps.remote.runtime.isRemote(id)
      ? deps.remote.runtime.isTurnRunning(id) ? 'active' : 'not_running'
      : deps.live(id)?.getStatus() ?? 'not_running',
    getWorkerFlowStatus: async id => ({ isWorking: deps.remote.runtime.isRemote(id) ? deps.remote.runtime.isTurnRunning(id) : deps.running(id),
      willQueue: true, queuedCount: (await deps.tasks.queued(id)).length, queuePaused: deps.paused(id) }),
    readLatestAssistantMessage: deps.latestText,
  };
  const api: OrcaMcpDeps = {
    startTeam: input => deps.lifecycle.startTeam(input),
    createWorker: input => deps.lifecycle.createWorker(input),
    listWorkers: async ({ leadSessionId }) => ({ ok: true, workers: (await deps.store.listWorkersByLead(leadSessionId)).map(worker => ({
      workerId: worker.id, sessionId: worker.sessionId, role: worker.role, agent: worker.session.agentKind,
      model: worker.session.model, effort: worker.session.effort, label: worker.label, status: worker.status,
      focused: worker.focused, idleSince: worker.idleSince,
    })) }),
    switchFocus: async ({ leadSessionId, workerIdOrLabel }) => {
      const authority = await deps.authority(leadSessionId), workers = await deps.store.listWorkersByLead(leadSessionId);
      const worker = findFocusTargetWorker(workers, workerIdOrLabel);
      if (!worker) return { ok: false, errorCode: 'WORKER_NOT_FOUND', message: 'Worker not found' };
      await authority.assertCurrent(); await deps.store.setWorkerFocus(worker.teamId, worker.id);
      // Keep the transcript switch immediate; sends already await the same boot promise.
      if (worker.status === 'idle' && !worker.executionDevice) void deps.resume(worker.sessionId, authority.assertCurrent).catch(deps.warn);
      deps.changed(leadSessionId); return { ok: true, workerId: worker.id };
    },
    sendToWorker: ({ images, ...input }) => deps.team.sendToWorker({ ...input, ...(images ? { imagePaths: images } : {}) }),
    interruptWorker: input => deps.team.interruptWorker(input),
    listWorkerQueuedMessages: input => deps.team.listWorkerQueuedMessages(input),
    updateWorkerQueuedMessage: input => deps.team.updateWorkerQueuedMessage(input),
    cancelWorkerQueuedMessage: input => deps.team.cancelWorkerQueuedMessage(input),
    mergeWorkerQueuedMessages: input => deps.team.mergeWorkerQueuedMessages(input),
    steerWorkerQueuedMessage: input => deps.team.steerWorkerQueuedMessage(input),
    moveWorkerQueuedMessage: input => deps.team.moveWorkerQueuedMessage(input),
    idleWorker: async input => {
      const result = await deps.team.idleWorker(input);
      if (result.ok) return result.workerId ? { ok: true, workerId: result.workerId } : { ok: false, errorCode: 'INTERNAL', message: 'Worker result unavailable' };
      return { ...result, errorCode: result.errorCode === 'WORKER_NOT_FOUND' || result.errorCode === 'ALREADY_IDLE' ? result.errorCode : 'INTERNAL' };
    },
    archiveWorker: async input => {
      const result = await deps.team.archiveWorker(input);
      if (result.ok) return result.workerId ? { ok: true, workerId: result.workerId } : { ok: false, errorCode: 'INTERNAL', message: 'Worker result unavailable' };
      return { ...result, errorCode: result.errorCode === 'WORKER_NOT_FOUND' ? result.errorCode : 'INTERNAL' };
    },
    endTeam: async ({ leadSessionId }) => { await deps.end(leadSessionId); return { ok: true }; },
    listAvailableModels: async ({ agent, callerSessionId, executionDeviceId, agentDeviceId: requestedDevice }) => {
      if (executionDeviceId) return { ok: true, ...await deps.remote.readModels(executionDeviceId, { ...(agent ? { agent } : {}), agentDeviceId: requestedDevice ?? null }) };
      const lead = callerSessionId ? await deps.tasks.get(callerSessionId) : null;
      const defaultDevice = lead?.groupBinding ? lead.groupBinding.groupDeviceId ?? null : lead?.agentDeviceId ?? null;
      const target = requestedDevice === undefined ? defaultDevice : requestedDevice === deps.selfDeviceId ? null : requestedDevice;
      const views = await deps.providers(target), kinds: readonly AgentKind[] = agent ? [agent] : ['claude-code', 'codex', 'pi'];
      return { ok: true, agentDeviceId: target, locations: await deps.locations(),
        ...Object.fromEntries(kinds.map(kind => [kind === 'claude-code' ? 'claude_code' : kind, deviceAvailableModels(views, kind)])) };
    },
    getWorkspaceInfo: async ({ leadSessionId }) => {
      const result = await getOrcaWorkspaceInfoReadOnly(diagnostics, leadSessionId);
      if (!result.ok) return { ...result, errorCode: 'INTERNAL' };
      const devices = await deps.remote.listExecutionDevices().catch(() => []);
      return { ...result, execution_devices: devices.map(device => ({ device_id: device.deviceId, name: device.name,
        platform: device.platform, supported: device.supported })) };
    },
    getWorkerStatus: ({ leadSessionId, workerId }) => getOrcaWorkerDiagnosticStatusReadOnly(diagnostics, leadSessionId, workerId),
    readWorker: ({ leadSessionId, workerId }) => readOrcaWorkerOutputReadOnly(diagnostics, leadSessionId, workerId),
  };
  const provider: McpProvider = { name: 'cindy_orca',
    capability: { title: 'Cindy collaboration', description: 'Create and manage collaboration teams', source: 'builtin' },
    toClaudeSdkConfig: ctx => ({ type: 'sdk', name: 'cindy_orca', instance: createOrcaMcpServer({ ...api, authorizeCall: deps.authorize(ctx) }, ctx) }),
  };
  return { api, provider };
}
