import { randomUUID } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient.js';
import { runAsBackgroundDbRpc } from '../localDb/client/rpcAdmission.js';
import type {
  PluginUsageHandle,
  PluginUsageIdentity,
  PluginUsageOutcome,
  PluginUsageSummary,
  PluginUsageTransaction,
} from '../../shared/pluginUsage.js';

export interface PluginUsageServiceDeps {
  client: DbClient;
  /** Must recheck the owner AND client epoch before every database operation. */
  isCurrent(): boolean;
  deviceName: string;
  now?: () => number;
  warn(): void;
}

/** One short write queue per owner/database epoch; it never waits for tool or HTTP results. */
export class PluginUsageService {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly handles = new Map<string, PluginUsageHandle>();
  private readonly paused = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: PluginUsageServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private assertCurrent(): void {
    if (!this.deps.isCurrent()) throw new Error('[HOST_NOT_READY] Plugin usage owner changed');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('[HOST_NOT_READY] Plugin usage closed'));
    const result = this.tail.then(async () => {
      this.assertCurrent();
      const value = await fn();
      this.assertCurrent();
      return value;
    });
    this.tail = result.catch(() => this.deps.warn());
    return result;
  }

  private tx(body: PluginUsageTransaction) {
    this.assertCurrent();
    return this.deps.client.tx('pluginUsage.execute', body);
  }

  bind(identity: PluginUsageIdentity, previousRevision?: string): Promise<void> {
    return this.enqueue(async () => {
      const handle = await this.tx({
        action: 'bind',
        identity,
        previousRevision,
        newId: randomUUID(),
        now: this.now(),
      });
      this.assertCurrent();
      if (handle) this.handles.set(identity.ghostId, handle);
    });
  }

  /** Freeze the generation/version before dispatch. An unready binding is never replayed. */
  capture(identity: PluginUsageIdentity): PluginUsageHandle | null {
    if (this.stopped || !this.deps.isCurrent() || this.paused.has(identity.ghostId)) return null;
    const handle = this.handles.get(identity.ghostId);
    if (
      !handle ||
      handle.identity.revision !== identity.revision ||
      handle.identity.stableKey !== identity.stableKey
    ) {
      void this.bind(identity).catch(() => undefined);
      return null;
    }
    return { ...handle, identity: { ...identity } };
  }

  /** Install/startup binding owns source verification; dispatch never rereads package files. */
  captureBound(ghostId: string, revision: string): PluginUsageHandle | null {
    if (this.stopped || !this.deps.isCurrent() || this.paused.has(ghostId)) return null;
    const handle = this.handles.get(ghostId);
    return handle?.identity.revision === revision
      ? { ...handle, identity: { ...handle.identity } }
      : null;
  }

  accept(
    handle: PluginUsageHandle,
    callId: string,
    toolName: string,
    sessionId: string | null,
    occurredAt: number,
  ): void {
    void this.enqueue(async () => {
      const refreshed = await this.tx({
        action: 'accept',
        handle,
        callId,
        toolName,
        sessionId,
        occurredAt,
      });
      // Refresh only future captures after a cross-instance clear. Never replay this call.
      this.assertCurrent();
      const current = this.handles.get(handle.identity.ghostId);
      if (
        refreshed &&
        current?.subjectId === handle.subjectId &&
        current.identity.revision === handle.identity.revision
      )
        this.handles.set(handle.identity.ghostId, refreshed);
    }).catch(() => undefined);
  }

  settle(handle: PluginUsageHandle, callId: string, outcome: PluginUsageOutcome): void {
    void this.enqueue(async () => {
      await this.tx({ action: 'settle', handle, callId, outcome });
    }).catch(() => undefined);
  }

  async detach(ghostId: string): Promise<void> {
    this.handles.delete(ghostId);
    await this.enqueue(async () => {
      await this.tx({ action: 'detach', ghostId });
    });
  }

  async clear(subjectId: string | null): Promise<void> {
    const affected = [...this.handles.values()].filter(
      (h) => subjectId === null || h.subjectId === subjectId,
    );
    for (const h of affected) this.paused.add(h.identity.ghostId);
    try {
      await this.enqueue(async () => {
        await this.tx({ action: 'clear', subjectId, now: this.now() });
        for (const h of affected) {
          this.assertCurrent();
          const row = await this.deps.client.queryOne<{ generation: number }>(
            'SELECT history_generation AS generation FROM plugin_usage_subjects WHERE id=?',
            [h.subjectId],
          );
          this.assertCurrent();
          const current = this.handles.get(h.identity.ghostId);
          if (
            row &&
            current?.subjectId === h.subjectId &&
            current.identity.revision === h.identity.revision
          )
            this.handles.set(h.identity.ghostId, { ...current, historyGeneration: row.generation });
        }
      });
    } finally {
      for (const h of affected) this.paused.delete(h.identity.ghostId);
    }
  }

  async summary(subjectId: string): Promise<PluginUsageSummary | null> {
    await this.tail;
    this.assertCurrent();
    const until = this.now();
    return runAsBackgroundDbRpc(async () => {
      this.assertCurrent();
      const row = await this.deps.client.queryOne<
        Pick<
          PluginUsageSummary,
          'recordingStartedAt' | 'lastUsedAt' | 'callsLast7Days' | 'totalCalls'
        >
      >(
        `
        SELECT s.recording_started_at AS recordingStartedAt,MAX(e.occurred_at) AS lastUsedAt,
          COUNT(e.call_id) AS totalCalls,
          COALESCE(SUM(CASE WHEN e.occurred_at>=? AND e.occurred_at<? THEN 1 ELSE 0 END),0) AS callsLast7Days
        FROM plugin_usage_subjects s LEFT JOIN plugin_usage_events e ON e.subject_id=s.id
        WHERE s.id=? GROUP BY s.id`,
        [until - 168 * 60 * 60 * 1000, until, subjectId],
      );
      this.assertCurrent();
      if (!row) return null;
      const recentTasks = await this.deps.client.query<PluginUsageSummary['recentTasks'][number]>(
        `
        SELECT t.id AS sessionId,t.title,MAX(e.occurred_at) AS lastUsedAt
        FROM plugin_usage_events e JOIN sessions t ON t.id=e.session_id
        WHERE e.subject_id=? AND t.status<>'deleted'
        GROUP BY t.id ORDER BY lastUsedAt DESC,t.id LIMIT 3`,
        [subjectId],
      );
      this.assertCurrent();
      return { ...row, subjectId, until, deviceName: this.deps.deviceName, recentTasks };
    });
  }

  async history(): Promise<
    { subjectId: string; ghostId: string; displayName: string; sourceKind: string }[]
  > {
    await this.tail;
    this.assertCurrent();
    const rows = await runAsBackgroundDbRpc(() =>
      this.deps.client.query<{
        subjectId: string;
        ghostId: string;
        displayName: string;
        sourceKind: string;
      }>(
        'SELECT id AS subjectId,ghost_id AS ghostId,display_name AS displayName,source_kind AS sourceKind FROM plugin_usage_subjects ORDER BY recording_started_at DESC,id',
      ),
    );
    this.assertCurrent();
    return rows;
  }

  /** Stop admission first; worker close is not a drain. No cross-owner retry on timeout. */
  async close(budgetMs = 2_000): Promise<void> {
    this.stopped = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.deps.warn();
            resolve();
          }, budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.handles.clear();
  }
}
