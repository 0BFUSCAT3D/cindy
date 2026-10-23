import type { Logger, Session } from '@cindy/maker-core';
import type { ResolvedRoute } from '@cindy/model-providers';
import { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';
import { dbToMakerAgentKind, makerToDbAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { createContextOverflowRollover, type ContextOverflowRolloverDeps, type OverflowSourceMessage } from '@cindy/im-runtime/contextOverflowRollover';
import type { TerminalTaskStorage, HistoryRecord } from './storage.js';
import type { TerminalTaskContext } from './context.js';
import type { ModelSelection } from '../models/config.js';

/** Desktop's recovery decisions with a file-backed, owner-scoped commit. */
export class TerminalTaskRecovery {
  readonly runtime: ReturnType<typeof createContextOverflowRollover>;
  private readonly windows = new Map<string, number | null>();
  private readonly committed = new Map<string, HistoryRecord>();
  constructor(host: {
    storage: TerminalTaskStorage; context: TerminalTaskContext; logger: Logger;
    assertCurrent(): void;
    getSession(id: string): Session | undefined;
    closeSession(id: string): Promise<void>;
    bootstrap(id: string): Promise<void>;
    messages(id: string): Promise<OverflowSourceMessage[]>;
    select(input: Record<string, unknown>): Promise<{ selection: ModelSelection; route: ResolvedRoute }>;
    changed(id: string, record?: HistoryRecord): Promise<void>;
    withCloseSuppressed<T>(id: string, run: () => Promise<T>): Promise<T>;
    withLock<T>(id: string, run: () => Promise<T>): Promise<T>;
    replay: ContextOverflowRolloverDeps['replayUserMessage'];
    hasExternalOwner(id: string): boolean;
  }) {
    this.runtime = createContextOverflowRollover({
      getSessionRow: async id => {
        host.assertCurrent(); const row = await host.storage.get(id); host.assertCurrent();
        if (!row) return null;
        // A disabled/unavailable route can still have history to recover. Missing
        // metadata is unknown capacity, never a reason to borrow another route.
        const resolved = await host.select({ ...row }).catch(() => null);
        host.assertCurrent();
        this.windows.set(this.key(row.agentKind, row.providerId, row.model), resolved ? this.verified(resolved) : null);
        return { status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', source: row.source ?? 'desktop', agentKind: makerToDbAgentKind(row.agentKind),
          remoteHostId: row.remoteHostId ?? null, clearedAt: row.clearedAt ?? null, sdkSessionId: row.sdkSessionId,
          contextTokens: row.usage?.contextTokens, contextWindow: row.usage?.contextWindow,
          model: row.model, providerId: row.providerId, workingDir: row.workDir };
      },
      resolveVerifiedWindow: (kind, model, provider) => this.windows.get(this.key(dbToMakerAgentKind(kind), provider, model)) ?? null,
      listMessages: host.messages,
      findLatestUser: async id => (await host.messages(id)).reverse().find(row => row.role === 'user') ?? null,
      findLatestRebuildMeta: async id => {
        const row = (await host.messages(id)).reverse().find(row => row.role === 'context_rebuild');
        return row?.agentMeta?.contextRebuild as { reason?: string; sourceUserClientId?: string | null } | undefined ?? null;
      },
      getLiveSession: host.getSession,
      closeSession: host.closeSession,
      rehydrateColdPiRuntimeForWindowVerification: host.bootstrap,
      drainPersistQueue: () => host.storage.flush(),
      commitRebuild: async (id, handoff, meta, signal) => {
        const record = await host.storage.commitContextRebuild(id, { ...meta, handoff }, () => { host.assertCurrent(); signal?.throwIfAborted(); });
        this.committed.set(id, record);
        await host.changed(id, record);
      },
      setPendingHandoff: (id, text, generation) => {
        const record = this.committed.get(id);
        if (!record?.clientId || record.contextRebuild?.handoff !== text) throw new Error('TASK_HANDOFF_COMMIT_MISSING');
        host.context.publishHandoff(id, record.clientId, text, generation);
      },
      readPendingHandoffGeneration: id => host.context.handoff.readGeneration(id),
      replayUserMessage: host.replay,
      hasExternalRecoveryOwner: host.hasExternalOwner,
      withSessionLock: host.withLock,
      withCloseSuppressed: host.withCloseSuppressed,
      log: host.logger,
    });
  }
  verified(value: { selection: ModelSelection; route: ResolvedRoute }) {
    return resolveVerifiedContextWindow({ providers: [value.route.provider] }, value.selection.agentKind, value.selection.providerId, value.selection.model);
  }
  private key(kind: string, provider: string | null | undefined, model: string) { return JSON.stringify([kind, provider ?? null, model]); }
}
