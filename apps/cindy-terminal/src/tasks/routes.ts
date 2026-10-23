import type { AgentKind, Logger, Session } from '@cindy/maker-core';
import type { ResolvedRoute } from '@cindy/model-providers';
import { shouldApplyExclusiveProviderReroute } from '@cindy/model-providers/model-route-guard';
import { dbToMakerAgentKind, makerToDbAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import {
  applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, performSessionAgentSwitch,
  projectPendingAgentSwitchIntent, type AgentSwitchBoundaryContent, type MakerSessionAgentSwitchHandlerDeps,
} from '@cindy/im-runtime/sessionAgentSwitch';
import type { TerminalModelConfig, ModelSelection } from '../models/config.js';
import type { TerminalTaskStorage, TerminalTaskMeta, HistoryRecord } from './storage.js';
import type { TerminalTaskContext } from './context.js';
import { TerminalTaskRecovery } from './recovery.js';
import type { ContextOverflowRolloverDeps, OverflowSourceMessage } from '@cindy/im-runtime/contextOverflowRollover';
import { assessRuntimeModelSwitchGate } from '@cindy/model-providers/runtimeModelSwitchGate';

type RouteRow = OverflowSourceMessage & { rowid: number };
type RoutePatch = Parameters<MakerSessionAgentSwitchHandlerDeps['applyAgentSwitchToDb']>[1];

/** One send/model mutation lane per persistent task. The shared switch state
 * machine decides when a choice applies; this adapter owns files and runtimes. */
export class TerminalTaskRoutes {
  readonly pending = createPendingAgentSwitchRegistry();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly committed = new Map<string, HistoryRecord>();
  private readonly providers = new Map<string, string | null>();
  readonly deps: MakerSessionAgentSwitchHandlerDeps;
  readonly recovery: TerminalTaskRecovery;
  constructor(private readonly host: {
    storage: TerminalTaskStorage; context: TerminalTaskContext; models: TerminalModelConfig; logger: Logger;
    assertCurrent(): void;
    getSession(id: string): Session | undefined;
    closeSession(id: string): Promise<void>;
    bootstrap(id: string): Promise<void>;
    messages(id: string): Promise<RouteRow[]>;
    select(input: Record<string, unknown>): Promise<{ selection: ModelSelection; route: ResolvedRoute }>;
    withCloseSuppressed<T>(id: string, run: () => Promise<T>): Promise<T>;
    changed(id: string, record?: HistoryRecord): Promise<void>;
    pendingChanged(id: string, intent: ReturnType<typeof projectPendingAgentSwitchIntent>): void;
    replay: ContextOverflowRolloverDeps['replayUserMessage'];
    hasExternalOwner(id: string): boolean;
  }) {
    this.recovery = new TerminalTaskRecovery({ ...host, withLock: (id, run) => this.withLock(id, run) });
    const current = async (id: string) => { host.assertCurrent(); const row = await host.storage.get(id); host.assertCurrent(); if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND'); this.providers.set(id, row.providerId ?? null); return row; };
    const resolve = async (id: string, kind: AgentKind, model: string, providerId: string | null | undefined, device?: string | null, effort?: string) => {
      const row = await current(id);
      const chosen = await host.select({ agentKind: kind, model, providerId: providerId === undefined && kind === row.agentKind ? row.providerId : providerId, agentDeviceId: device === undefined ? row.agentDeviceId : device, ...(effort ? { effort } : {}) });
      host.assertCurrent(); return chosen;
    };
    const metadata = async (id: string, patch: RoutePatch): Promise<Partial<TerminalTaskMeta>> => {
      const chosen = await resolve(id, dbToMakerAgentKind(patch.agentKind), patch.model, patch.providerId, patch.agentDeviceId, patch.effort);
      return { ...chosen.selection, sdkSessionId: patch.sdkSessionId ?? undefined,
        thinkingEnabled: patch.thinkingEnabled,
        ...(patch.agentDeviceId !== undefined ? { agentDeviceId: patch.agentDeviceId ?? undefined } : {}),
        ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}) };
    };
    const commit = async (id: string, patch: Partial<TerminalTaskMeta>, boundary: AgentSwitchBoundaryContent, replace?: string) => {
      const record = await host.storage.commitRouteChange(id, patch, boundary, host.assertCurrent, replace);
      this.committed.set(id, record);
      await host.changed(id, record);
      return record.clientId!;
    };
    this.deps = {
      pendingSwitches: this.pending, log: host.logger,
      shouldApplyExclusiveProviderReroute: provider => shouldApplyExclusiveProviderReroute(provider, host.models.providerSources()),
      getSessionRow: async id => { const row = await current(id); return { ...row, agentKind: makerToDbAgentKind(row.agentKind), model: row.model, providerId: row.providerId ?? null, sdkSessionId: row.sdkSessionId ?? null, status: 'active', remoteHostId: null, orcaRole: null }; },
      getLiveSession: host.getSession,
      closeSession: host.closeSession,
      withCloseSuppressed: host.withCloseSuppressed,
      withSessionLock: (id, run) => this.withLock(id, run),
      assertModelRouteUsable: async (kind, model, provider, id, device) => (await resolve(id!, kind, model, provider, device)).selection.providerId,
      assertAgentDeviceRouteUsable: async (device, kind, model, provider) => { await host.select({ agentDeviceId: device, agentKind: kind, model, providerId: provider }); host.assertCurrent(); },
      listMessagesForHandoff: async (id, after) => (await host.messages(id)).filter(row => !after || row.createdAt > after.createdAt || row.createdAt === after.createdAt && row.rowid > after.rowid),
      findParkedEngineSession: async (id, kind) => {
        const rows = await host.messages(id);
        for (const row of rows.reverse()) {
          if (row.role === 'context_rebuild') return null;
          if (row.role !== 'agent_switch' || !row.content || typeof row.content !== 'object') continue;
          const boundary = row.content as AgentSwitchBoundaryContent;
          if (boundary.fromAgentKind !== kind) continue;
          return boundary.fromSdkSessionId ? { sdkSessionId: boundary.fromSdkSessionId, watermarkCreatedAt: row.createdAt, watermarkRowid: row.rowid } : null;
        }
        return null;
      },
      applyAgentSwitchToDb: async (id, patch) => { await host.storage.updateIf(id, row => !row.deleted && !row.archived, await metadata(id, patch), host.assertCurrent); await host.changed(id); },
      commitAgentSwitch: async (id, patch, boundary) => commit(id, await metadata(id, patch), boundary),
      setSessionProvider: (id, provider) => { host.assertCurrent(); this.providers.set(id, provider); },
      insertBoundaryMessage: (id, boundary) => commit(id, {}, boundary),
      applyResumeFallbackAtomically: async (id, clientId, boundary) => { await commit(id, { sdkSessionId: undefined }, boundary, clientId); },
      setPendingHandoff: (id, text, generation) => {
        const record = this.committed.get(id);
        if (!record?.clientId || record.boundary?.handoff !== text) throw new Error('TASK_HANDOFF_COMMIT_MISSING');
        host.context.publishHandoff(id, record.clientId, text, generation);
      },
      readPendingHandoffGeneration: id => host.context.handoff.readGeneration(id),
      bootstrapSwitchedSession: id => host.bootstrap(id),
      onPendingSwitchChanged: host.pendingChanged,
      onUserRouteSelectionLanded: async id => { await host.storage.updateIf(id, row => !row.deleted, { imDefaultRoute: null }, host.assertCurrent); },
      selectSameAgentModel: async (id, intent, apply, assertCurrent, beforeMutation) => {
        const row = await current(id);
        const chosen = await resolve(id, row.agentKind, intent.model, intent.providerId, undefined, intent.effort);
        await beforeMutation?.(); host.assertCurrent(); assertCurrent?.();
        if (!apply) { this.pending.set(id, intent); host.pendingChanged(id, projectPendingAgentSwitchIntent(this.pending.get(id))); return { deferred: true }; }
        if (host.getSession(id)?.isTurnRunning()) return { deferred: true };
        await host.withCloseSuppressed(id, async () => {
          await this.prepareModelWindow(id, row, chosen, intent.confirmedContextWindow);
          await host.closeSession(id);
          host.assertCurrent();
          const updated = await host.storage.updateIf(id, current => !current.deleted && !current.archived && current.agentKind === row.agentKind && current.clearedAt === row.clearedAt,
            { ...chosen.selection, thinkingEnabled: intent.thinking, ...(intent.fastMode !== undefined ? { fastMode: intent.fastMode } : {}) }, host.assertCurrent);
          if (!updated) throw new Error('TASK_ROUTE_CHANGED');
          this.providers.set(id, updated.providerId ?? null);
          await host.changed(id);
          // Pi's final get_state may report a smaller window than the catalog.
          // Verify that live window before any message can reach the new model.
          if (updated.agentKind === 'pi') {
            await host.bootstrap(id);
            const actual = host.getSession(id)?.getUsageSnapshot().contextWindow;
            if (actual && actual > 0) await this.prepareWindow(id, actual);
          }
        });
        return { deferred: false };
      },
    };
  }
  provider(id: string) { return this.providers.get(id) ?? null; }
  private async prepareWindow(id: string, contextWindow: number) {
    const result = await this.recovery.runtime.prepareModelWindowSwitch(id, { contextWindow, recheckTargetPressure: true, confirmedTargetPressure: true, assertCanCommit: this.host.assertCurrent });
    if (result === 'busy' || result === 'in-flight' || result === 'remote-unsupported' || result === 'confirmation-required') throw new Error('TASK_MODEL_WINDOW_NOT_READY');
  }
  private async prepareModelWindow(id: string, row: TerminalTaskMeta, chosen: { selection: ModelSelection; route: ResolvedRoute }, confirmation?: number) {
    if (row.agentKind === 'codex' || row.model === chosen.selection.model && row.providerId === chosen.selection.providerId) return;
    let live = this.host.getSession(id);
    if (row.agentKind === 'pi' && !live && row.sdkSessionId) { await this.host.bootstrap(id); live = this.host.getSession(id); }
    const preview = row.agentKind === 'pi' ? await live?.previewModelSwitch(chosen.selection.model, { providerId: chosen.selection.providerId }) : undefined;
    if (preview?.action === 'unavailable') throw new Error('MODEL_ROUTE_UNAVAILABLE');
    const catalogTarget = this.recovery.verified(chosen);
    const target = preview?.windowVerified && preview.targetContextWindow ? Math.min(preview.targetContextWindow, catalogTarget ?? Infinity) : catalogTarget;
    if (confirmation !== undefined && confirmation !== target) throw new Error('MODEL_WINDOW_CONFIRMATION_CHANGED');
    const current = await this.host.select({ ...row }).catch(() => null);
    const usage = live?.getUsageSnapshot();
    const tokens = usage && usage.contextTokens > 0 ? usage.contextTokens : row.usage?.contextTokens;
    const gate = assessRuntimeModelSwitchGate({ inTurn: live?.isTurnRunning() === true, isRemote: Boolean(row.remoteHostId), agentKind: row.agentKind,
      runtimeRouteChanged: true, verifiedTargetWindow: target,
      verifiedCurrentWindow: row.agentKind === 'pi' ? usage?.contextWindow : current ? this.recovery.verified(current) : null,
      contextTokensKnown: tokens !== undefined, contextTokens: tokens ?? 0 });
    if (gate.reject || gate.defer) throw new Error('TASK_MODEL_WINDOW_NOT_READY');
    if (!gate.skipRebuild && target) await this.prepareWindow(id, target);
  }
  intent(id: string) { return projectPendingAgentSwitchIntent(this.pending.get(id)); }
  async acquire(id: string): Promise<() => void> {
    this.host.assertCurrent();
    const previous = this.lanes.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate); this.lanes.set(id, tail);
    let released = false;
    const done = () => { if (released) return; released = true; release(); if (this.lanes.get(id) === tail) this.lanes.delete(id); };
    await previous;
    try { this.host.assertCurrent(); return done; } catch (error) { done(); throw error; }
  }
  async withLock<T>(id: string, run: () => Promise<T>) { const release = await this.acquire(id); try { return await run(); } finally { release(); } }
  select(params: Parameters<typeof performSessionAgentSwitch>[1]) {
    if (typeof params.sessionId !== 'string') return performSessionAgentSwitch(this.deps, params);
    return this.withLock(params.sessionId, () => performSessionAgentSwitch(this.deps, params));
  }
  selectModel(id: string, model: string, providerId: unknown, options: Record<string, unknown>, expectedRevision: unknown, guard: () => void) {
    return this.withLock(id, async () => {
      guard();
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) throw new Error('INVALID_PARAMS');
      if (expectedRevision !== undefined && this.pending.revision?.(id) !== expectedRevision) return { deferred: false, superseded: true };
      const row = await this.host.storage.get(id); if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
      return performSessionAgentSwitch(this.deps, { sessionId: id, targetAgentKind: row.agentKind, model, providerId, effort: options.effort, fastMode: options.fastMode,
        thinking: options.thinking, confirmedContextWindow: options.confirmedContextWindow, assertSelectionCurrent: guard });
    });
  }
  async acquireForSend(id: string): Promise<() => void> {
    const release = await this.acquire(id);
    try {
      await applyPendingAgentSwitchIfIdle(this.deps, id);
      this.host.assertCurrent();
      // The legacy Desktop switch helper retains a failed cross-engine intent.
      // A terminal send must report that state instead of using the old route.
      if (this.pending.get(id)) throw new Error('TASK_MODEL_SWITCH_NOT_READY');
      await this.recovery.runtime.prepareUnhealthySession(id);
      return release;
    }
    catch (error) { release(); throw error; }
  }
}
