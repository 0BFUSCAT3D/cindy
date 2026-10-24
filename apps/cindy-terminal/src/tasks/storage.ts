import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { SessionMeta, SessionStorage, AgentEvent, UserMessage } from '@cindy/maker-core';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { ModelSelection } from '../models/config.js';
import type { ImBindingRow } from '@cindy/im-runtime/binding';
import { validateImBindingRow } from '../im/bindings.js';

export type TerminalTaskMeta = SessionMeta & {
  worktreePath?: string;
  providerId?: string; archived?: boolean; deleted?: boolean; pinnedAt?: number | null; agentDeviceId?: string;
  groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding;
  queuePaused?: boolean; queueExpanded?: boolean; clearedAt?: number; source?: string;
  imBotContextId?: string; imUserId?: string; imScopeKey?: string; imDefaultRoute?: string | null;
  workspaceKind?: 'project' | 'dialogue'; userSendAt?: number;
  pendingHandoff?: { id: string; text: string; createdAt: number } | null;
  goalContinuation?: import('@cindy/im-runtime/goalInactiveNote').GoalContinuationState | null;
  thinkingEnabled?: boolean; hiddenAt?: number | null;
  orcaRole?: 'lead' | 'worker' | null;
  orcaRemoteLead?: import('@cindy/maker-shared/orca-remote-worker').OrcaRemoteLead;
  usage?: { tokenUsage: number; contextTokens: number; contextWindow: number; costUsd: number };
};
export type NewTerminalTaskMeta = Omit<TerminalTaskMeta, 'createdAt' | 'updatedAt'>;
export type TerminalOrcaReport = {
  phase: 'pending' | 'ready' | 'delivered' | 'suppressed';
  /** Stable Lead receipt ID, independent of daemon and native session lifetime. */
  clientId: string;
  content?: string;
  completion?: 'done' | 'error';
  /** The shared lifecycle committed its Worker status after report delivery. */
  settled?: boolean;
};
type ChannelRotation = { version: 1; rows: TerminalTaskMeta[]; bindings: ImBindingRow[] };
export type Submission = { targetPlugin?: { id: string; name: string }; orcaReport?: TerminalOrcaReport; collaboration?: import('./orca-input.js').TerminalOrcaInput; orca?: import('./orca-remote.js').RemoteWorkerAssignment; requestId: string; sessionId: string; fingerprint: string; sendAtMs?: number; plugin?: { id: string; name: string }; sender?: {sessionId:string;title?:string}; status: 'queued' | 'sending' | 'running' | 'completed' | 'failed' | 'interrupted'; createdAt: number; updatedAt: number; error?: string; finalText?: string; message?: UserMessage; source?: 'local' | 'remote'; deviceId?: string; sourceDevice?: import('../contracts.js').InvocationContext['sourceDevice']; ownerId?: string; deliveryProof?: import('./handoff.js').TaskDeliveryProof; scheduler?: {kind:'scheduler';scheduleId:string;scheduleName:string;runId:string;firedAt?:number}; sharedTask?: import('../contracts.js').InvocationContext['sharedTask'] };
export type ContextRebuild = Parameters<import('@cindy/im-runtime/contextOverflowRollover').ContextOverflowRolloverDeps['commitRebuild']>[2] & { handoff: string };
export type QueuedSubmissionPatch = Pick<Partial<Submission>, 'message' | 'collaboration' | 'status' | 'error'>;
export type HistoryRecord = { sequence: number; timestamp: number; kind: 'event' | 'user' | 'user-meta' | 'boundary' | 'boundary-meta' | 'context-rebuild'; event?: AgentEvent; message?: UserMessage; origin?: 'local' | 'remote'; agentMeta?: Record<string, unknown>; clientId?: string; boundary?: import('@cindy/im-runtime/sessionAgentSwitch').AgentSwitchBoundaryContent; contextRebuild?: ContextRebuild };
type RouteCommit = { version: 1; row: TerminalTaskMeta; record: HistoryRecord };
function taskId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('INVALID_TASK_ID');
  return value;
}

/** Per-task atomic metadata and append-only history. Live status is never persisted. */
export class TerminalTaskStorage implements SessionStorage {
  private readonly rows = new Map<string, TerminalTaskMeta>();
  private readonly submissions = new Map<string, Submission[]>();
  private readonly nextSequences = new Map<string, number>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private metadataBarrier: Promise<void> = Promise.resolve();
  private metadataFault: unknown;
  private readonly routeFaults = new Map<string, unknown>();
  constructor(private readonly root: string) {}
  private directory(id: string) { return path.join(this.root, taskId(id)); }
  private file(id: string) { return path.join(this.directory(id), 'task.json'); }
  async open(): Promise<void> {
    await privateDirectory(this.root);
    // Complete a committed multi-file rotation before any task or binding
    // index is exposed. Individual files remain the normal storage format.
    const rotation = await readPrivateFile(this.rotationFile());
    if (rotation) await this.materializeRotation(this.parseRotation(JSON.parse(rotation.toString())));
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
      await this.repairInterruptedAppend(entry.name);
      const routeCommit = await readPrivateFile(this.routeCommitFile(entry.name));
      if (routeCommit) await this.materializeRouteCommit(entry.name, this.parseRouteCommit(entry.name, JSON.parse(routeCommit.toString())));
      const raw = await readPrivateFile(this.file(entry.name));
      if (!raw) throw new Error('TASK_METADATA_MISSING');
      const row = JSON.parse(raw.toString()) as TerminalTaskMeta;
      if (row.id !== entry.name || !['claude-code', 'codex', 'pi'].includes(row.agentKind) || typeof row.model !== 'string' || typeof row.workDir !== 'string') throw new Error('INVALID_TASK_METADATA');
      this.rows.set(row.id, row);
      const receipts = await readPrivateFile(path.join(this.directory(row.id), 'requests.json'));
      const entries: Submission[] = receipts ? JSON.parse(receipts.toString()) : [];
      for (const receipt of entries) {
        if (receipt.sessionId !== row.id || typeof receipt.requestId !== 'string') throw new Error('INVALID_SUBMISSION_METADATA');
        if (['sending', 'running'].includes(receipt.status)) { receipt.status = 'interrupted'; receipt.updatedAt = Date.now(); }
      }
      this.submissions.set(row.id, entries);
      if (receipts) await atomicPrivateWrite(path.join(this.directory(row.id), 'requests.json'), JSON.stringify(entries));
    }
  }
  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.metadataBarrier, this.writes.get(id)]).then(() => { this.assertRouteHealthy(id); return action(); });
    this.writes.set(id, result.catch(() => undefined));
    return result;
  }
  async create(meta: NewTerminalTaskMeta, guard: () => void = () => {}): Promise<TerminalTaskMeta> {
    return this.enqueue(meta.id, async () => {
      guard();
      if (this.rows.has(meta.id)) throw new Error('TASK_ALREADY_EXISTS');
      await privateDirectory(this.directory(meta.id));
      const row = { ...meta, createdAt: Date.now(), updatedAt: Date.now() };
      guard();
      await atomicPrivateWrite(this.file(meta.id), JSON.stringify(row));
      this.rows.set(meta.id, row);
      return structuredClone(row);
    });
  }
  historyRevision(id: string): number { taskId(id); return this.nextSequences.get(id) ?? 0; }
  async get(id: string): Promise<TerminalTaskMeta | null> {
    taskId(id);
    await this.metadataBarrier;
    await this.writes.get(id);
    this.assertRouteHealthy(id);
    return this.rows.has(id) ? structuredClone(this.rows.get(id)!) : null;
  }
  async list(): Promise<TerminalTaskMeta[]> {
    await this.flush();
    return [...this.rows.values()].map(row => structuredClone(row)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  /** Commit the fresh task, previous task state and takeover snapshot at one
   * journal boundary. The binding store holds its mutation queue around this
   * operation, so a newer takeover cannot be overwritten by a stale /new. */
  rotateChannelTask(meta: NewTerminalTaskMeta, previousId: string | null, bindings: ImBindingRow[], guard: () => void): Promise<TerminalTaskMeta> {
    taskId(meta.id);
    if (previousId) taskId(previousId);
    const prior = [this.metadataBarrier, ...this.writes.values()];
    const operation = Promise.all(prior).then(async () => {
      guard();
      if (this.rows.has(meta.id)) throw new Error('TASK_ALREADY_EXISTS');
      const previous = previousId ? this.rows.get(previousId) : undefined;
      if (previousId && !previous) throw new Error('TASK_NOT_FOUND');
      const now = Math.max(Date.now(), (previous?.createdAt ?? 0) + 1), row = { ...meta, createdAt: now, updatedAt: now };
      const rotation = this.parseRotation({ version: 1, rows: [row, ...(previous ? [{ ...previous, archived: previous.deleted ? previous.archived : true, updatedAt: now }] : [])], bindings });
      guard();
      // The durable journal is the commit point. Any later I/O failure blocks
      // this owner until startup recovery, rather than accepting more writes
      // over a partly materialized transaction.
      await atomicPrivateWrite(this.rotationFile(), JSON.stringify(rotation));
      try {
        await this.materializeRotation(rotation);
        for (const changed of rotation.rows) this.rows.set(changed.id, changed);
        return structuredClone(row);
      } catch (error) { this.metadataFault = error; throw error; }
    });
    this.metadataBarrier = operation.then(() => {}, () => { if (this.metadataFault) throw this.metadataFault; });
    void this.metadataBarrier.catch(() => {});
    return operation;
  }
  private rotationFile() { return path.join(this.root, 'channel-rotation.json'); }
  private parseRotation(input: unknown): ChannelRotation {
    const value = input as Partial<ChannelRotation> | null;
    if (!value || value.version !== 1 || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 2 || !Array.isArray(value.bindings)) throw new Error('INVALID_CHANNEL_ROTATION');
    for (const row of value.rows) {
      if (!row || typeof row.id !== 'string' || !['claude-code', 'codex', 'pi'].includes(row.agentKind) || typeof row.model !== 'string' || typeof row.workDir !== 'string' || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt)) throw new Error('INVALID_CHANNEL_ROTATION');
      taskId(row.id);
    }
    if (new Set(value.rows.map(row => row.id)).size !== value.rows.length) throw new Error('INVALID_CHANNEL_ROTATION');
    return { version: 1, rows: value.rows, bindings: value.bindings.map(validateImBindingRow) };
  }
  private async materializeRotation(rotation: ChannelRotation) {
    for (const row of rotation.rows) {
      await privateDirectory(this.directory(row.id));
      await atomicPrivateWrite(this.file(row.id), JSON.stringify(row));
    }
    await atomicPrivateWrite(path.join(path.dirname(this.root), 'channel-bindings.json'), JSON.stringify(rotation.bindings));
    await rm(this.rotationFile(), { force: true });
  }
  update(id: string, patch: Partial<TerminalTaskMeta>): Promise<TerminalTaskMeta> {
    return this.enqueue(id, async () => {
      const row = this.rows.get(id);
      if (!row) throw new Error('TASK_NOT_FOUND');
      const next = { ...row, ...patch, id: row.id, createdAt: row.createdAt, updatedAt: Date.now() };
      await atomicPrivateWrite(this.file(id), JSON.stringify(next));
      this.rows.set(id, next);
      return structuredClone(next);
    });
  }
  compareAndClearSdkSessionId(id: string, expected: string): Promise<boolean> {
    return this.enqueue(id, async () => {
      const row = this.rows.get(id);
      if (!row || row.sdkSessionId !== expected) return false;
      const next = { ...row, updatedAt: Date.now() };
      delete next.sdkSessionId;
      await atomicPrivateWrite(this.file(id), JSON.stringify(next));
      this.rows.set(id, next);
      return true;
    });
  }
  /** The predicate is evaluated inside the task's write lane, so accepting an
   * older turn cannot consume a handoff committed by a later model switch. */
  updateIf(id: string, predicate: (row: Readonly<TerminalTaskMeta>) => boolean, patch: Partial<TerminalTaskMeta>, guard: () => void): Promise<TerminalTaskMeta | null> {
    return this.enqueue(id, async () => {
      guard();
      const row = this.rows.get(id);
      if (!row || !predicate(row)) return null;
      const next = { ...row, ...patch, id: row.id, createdAt: row.createdAt, updatedAt: Date.now() };
      await atomicPrivateWrite(this.file(id), JSON.stringify(next));
      this.rows.set(id, next);
      return structuredClone(next);
    });
  }
  delete(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      // Atomic rename is not needed for deletion: the host first closes the runtime.
      await rm(this.directory(id), { force: true, recursive: true });
      this.rows.delete(id);
      this.nextSequences.delete(id);
    });
  }
  setSelection(id: string, selection: ModelSelection) { return this.update(id, { agentKind: selection.agentKind, providerId: selection.providerId, model: selection.model, effort: selection.effort }); }
  private assertRouteHealthy(id: string) { if (this.routeFaults.has(id)) throw this.routeFaults.get(id); }
  private routeCommitFile(id: string) { return path.join(this.directory(id), 'route-commit.json'); }
  private parseRouteCommit(id: string, input: unknown): RouteCommit {
    const value = input as Partial<RouteCommit> | null;
    if (!value || value.version !== 1 || value.row?.id !== id || !value.record
      || !['claude-code', 'codex', 'pi'].includes(value.row.agentKind) || typeof value.row.workDir !== 'string' || typeof value.row.model !== 'string'
      || !['boundary', 'boundary-meta', 'context-rebuild'].includes(value.record.kind) || !value.record.clientId
      || !Number.isSafeInteger(value.record.sequence) || value.record.sequence < 1 || !Number.isSafeInteger(value.record.timestamp)
      || typeof (value.record.boundary ?? value.record.contextRebuild)?.handoff !== 'string' || value.row.pendingHandoff?.id !== value.record.clientId
      || value.row.pendingHandoff.text !== (value.record.boundary ?? value.record.contextRebuild)?.handoff) throw new Error('INVALID_TASK_ROUTE_COMMIT');
    return value as RouteCommit;
  }
  /** Recovery is idempotent on either side of the journal append. There can be
   * no newer writes after a committed transaction until it is materialized. */
  private async materializeRouteCommit(id: string, transaction: RouteCommit) {
    const last = (await this.readHistory(id, 0, 1, true)).records[0];
    const record = transaction.record;
    if ((last?.sequence ?? 0) === record.sequence - 1) await this.writeRecord(id, record);
    else {
      const existing = (await this.readHistory(id, record.sequence - 1, 1)).records[0];
      if (last?.sequence !== record.sequence || JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('TASK_ROUTE_JOURNAL_CONFLICT');
      this.nextSequences.set(id, record.sequence);
    }
    await atomicPrivateWrite(this.file(id), JSON.stringify(transaction.row));
    await rm(this.routeCommitFile(id), { force: true, maxRetries: 5, retryDelay: 100 });
    this.rows.set(id, transaction.row);
  }
  /** Route, visible boundary and next-send context share one durable commit.
   * Resume fallback replaces the boundary projection while clearing its SDK ID. */
  commitRouteChange(id: string, patch: Partial<TerminalTaskMeta>, boundary: NonNullable<HistoryRecord['boundary']>, guard: () => void, replaceClientId?: string): Promise<HistoryRecord> {
    return this.commitContext(id, patch, { kind: replaceClientId ? 'boundary-meta' : 'boundary', boundary }, boundary.handoff, guard, replaceClientId);
  }
  commitContextRebuild(id: string, rebuild: ContextRebuild, guard: () => void): Promise<HistoryRecord> {
    return this.commitContext(id, {}, { kind: 'context-rebuild', contextRebuild: rebuild }, rebuild.handoff, guard);
  }
  private commitContext(id: string, patch: Partial<TerminalTaskMeta>, input: Pick<HistoryRecord, 'kind' | 'boundary' | 'contextRebuild'>, handoff: string, guard: () => void, replaceClientId?: string): Promise<HistoryRecord> {
    return this.enqueue(id, async () => {
      guard();
      const prior = this.rows.get(id);
      if (!prior || prior.deleted || prior.archived) throw new Error('TASK_NOT_FOUND');
      if (replaceClientId && prior.pendingHandoff?.id !== replaceClientId) throw new Error('TASK_HANDOFF_CHANGED');
      const rebuild = input.contextRebuild;
      if (rebuild) {
        if (rebuild.expectedClearedAt !== undefined && (prior.clearedAt ?? null) !== rebuild.expectedClearedAt) throw new Error('TASK_CONTEXT_CHANGED');
        if (rebuild.replacementRoute && prior.sdkSessionId !== rebuild.replacementRoute.expectedSdkSessionId) throw new Error('TASK_NATIVE_SESSION_CHANGED');
        patch = { sdkSessionId: undefined, usage: { tokenUsage: prior.usage?.tokenUsage ?? 0, contextTokens: 0, contextWindow: prior.usage?.contextWindow ?? 0, costUsd: prior.usage?.costUsd ?? 0 },
          ...(rebuild.replacementRoute ? { model: rebuild.replacementRoute.model, providerId: rebuild.replacementRoute.providerId ?? undefined, effort: rebuild.replacementRoute.effort as ModelSelection['effort'], fastMode: rebuild.replacementRoute.fastMode } : {}) };
      }
      const last = (await this.readHistory(id, 0, 1, true)).records[0];
      const timestamp = Math.max(Date.now(), (prior.clearedAt ?? 0) + 1), clientId = replaceClientId ?? randomUUID();
      const record: HistoryRecord = { sequence: (last?.sequence ?? 0) + 1, timestamp, ...input, clientId };
      const row = { ...prior, ...patch, id: prior.id, createdAt: prior.createdAt, updatedAt: timestamp, pendingHandoff: { id: clientId, text: handoff, createdAt: timestamp } };
      const transaction = this.parseRouteCommit(id, { version: 1, row, record });
      guard();
      await atomicPrivateWrite(this.routeCommitFile(id), JSON.stringify(transaction));
      try { await this.materializeRouteCommit(id, transaction); }
      catch (error) { this.routeFaults.set(id, error); throw error; }
      return structuredClone(record);
    });
  }
  append(id: string, input: Omit<HistoryRecord, 'sequence' | 'timestamp'>): Promise<HistoryRecord> {
    return this.enqueue(id, async () => {
      if (!this.rows.has(id)) throw new Error('TASK_NOT_FOUND');
      return this.appendRecord(id, input);
    });
  }
  /** Enrich an existing early IM row without duplicating its body. The lookup
   * and append share the task write queue, including deletion and /clear. */
  patchUserMeta(id: string, clientId: string, patch: Record<string, unknown>, guard: () => void): Promise<HistoryRecord | null> {
    return this.enqueue(id, async () => {
      guard();
      const task = this.rows.get(id);
      if (!task || task.deleted) return null;
      let cursor = 0, found = false;
      do {
        const page = await this.readHistory(id, cursor, 1000);
        found = page.records.some(row => row.kind === 'user' && row.clientId === clientId && row.timestamp > (task.clearedAt ?? 0));
        if (found || !page.hasMore) break;
        cursor = page.nextCursor;
      } while (true);
      guard();
      return found ? this.appendRecord(id, { kind: 'user-meta', clientId, agentMeta: patch }) : null;
    });
  }
  private async appendRecord(id: string, input: Omit<HistoryRecord, 'sequence' | 'timestamp'>): Promise<HistoryRecord> {
      let next = this.nextSequences.get(id);
      if (next === undefined) {
        const page = await this.readHistory(id, 0, 1, true);
        next = page.records[0]?.sequence ?? 0;
      }
      const record: HistoryRecord = { ...input, timestamp: Date.now(), sequence: next + 1 };
      await this.writeRecord(id, record);
      return record;
  }
  private async writeRecord(id: string, record: HistoryRecord) {
      const handle = await open(path.join(this.directory(id), 'events.jsonl'), 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      this.nextSequences.set(id, record.sequence);
  }
  /** Only an incomplete trailing record can arise from an interrupted append.
   * Drop those uncommitted bytes before reusing its sequence; never ignore a
   * corrupt committed record in the middle of the journal. */
  private async repairInterruptedAppend(id: string) {
    const handle = await open(path.join(this.directory(id), 'events.jsonl'), 'r+').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 10) return;
      let offset = size;
      while (offset > 0) {
        const start = Math.max(0, offset - 64 * 1024);
        const chunk = Buffer.alloc(offset - start);
        await handle.read(chunk, 0, chunk.length, start);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) { await handle.truncate(start + newline + 1); await handle.sync(); return; }
        offset = start;
      }
      await handle.truncate(0);
      await handle.sync();
    } finally { await handle.close(); }
  }
  async history(id: string, after = 0, limit = 200) {
    taskId(id);
    await this.metadataBarrier;
    await this.writes.get(id);
    this.assertRouteHealthy(id);
    if (!this.rows.has(id)) throw new Error('TASK_NOT_FOUND');
    return this.readHistory(id, after, Math.max(1, Math.min(1000, limit)));
  }
  private async readHistory(id: string, after: number, limit: number, tailOnly = false): Promise<{ records: HistoryRecord[]; nextCursor: number; hasMore: boolean }> {
    const records: HistoryRecord[] = [];
    const input = createReadStream(path.join(this.directory(id), 'events.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let hasMore = false;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let value: HistoryRecord;
        try { value = JSON.parse(line) as HistoryRecord; }
        catch { throw new Error('TASK_HISTORY_CORRUPT'); }
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error('TASK_HISTORY_CORRUPT');
        if (tailOnly) { records[0] = value; continue; }
        if (value.sequence <= after) continue;
        if (records.length >= limit) { hasMore = true; break; }
        records.push(value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally { lines.close(); input.destroy(); }
    return { records, nextCursor: records.at(-1)?.sequence ?? after, hasMore };
  }
  async queued(id: string): Promise<Submission[]> { await this.writes.get(id); return structuredClone((this.submissions.get(id) ?? []).filter(item => item.status === 'queued')); }
  async submission(id: string, requestId: string): Promise<Submission | null> {
    taskId(id); await this.writes.get(id);
    return structuredClone(this.submissions.get(id)?.find(item => item.requestId === requestId) ?? null);
  }
  async reportSubmissions(id: string): Promise<Submission[]> {
    taskId(id); await this.writes.get(id);
    return structuredClone((this.submissions.get(id) ?? []).filter(item => item.orcaReport));
  }
  async latestSubmission(id: string): Promise<Submission | null> {
    taskId(id); await this.writes.get(id);
    return structuredClone(this.submissions.get(id)?.at(-1) ?? null);
  }
  changeOrcaReport(id: string, requestId: string, change: (current: TerminalOrcaReport | undefined) => TerminalOrcaReport | undefined, guard: () => void): Promise<TerminalOrcaReport | undefined> {
    return this.enqueue(id, async () => {
      guard();
      const entries = this.submissions.get(id) ?? [], found = entries.find(item => item.requestId === requestId);
      if (!found || found.collaboration?.source !== 'lead') throw new Error('ORCA_REPORT_INPUT_NOT_FOUND');
      const report = change(structuredClone(found.orcaReport));
      const next = entries.map(item => item === found ? { ...item, orcaReport: report } : item);
      guard();
      try { await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(next)); }
      catch (error) { this.routeFaults.set(id, error); throw error; }
      this.submissions.set(id, next);
      return structuredClone(report);
    });
  }
  claimSubmission(id: string, requestId: string, fingerprint: string, guard: () => void, payload?: Pick<Submission, 'message' | 'source' | 'deviceId' | 'sourceDevice' | 'ownerId' | 'sharedTask' | 'scheduler' | 'sendAtMs' | 'deliveryProof' | 'sender' | 'plugin' | 'targetPlugin' | 'orca' | 'collaboration'>, atHead = false): Promise<{ receipt: Submission; created: boolean }> {
    return this.enqueue(id, async () => {
      guard();
      if (!this.rows.has(id)) throw new Error('TASK_NOT_FOUND');
      const entries = this.submissions.get(id) ?? [];
      const found = entries.find(item => item.requestId === requestId);
      if (found) {
        if (found.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return { receipt: structuredClone(found), created: false };
      }
      const receipt: Submission = { ...payload, requestId, sessionId: id, fingerprint, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() };
      const updated = [...entries];
      const position = atHead ? updated.findIndex(item => item.status === 'queued') : -1;
      updated.splice(position < 0 ? updated.length : position, 0, receipt);
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(updated));
      this.submissions.set(id, updated);
      return { receipt: structuredClone(receipt), created: true };
    });
  }
  editQueuedSubmission(id:string,requestId:string,patch:Partial<Submission>,guard:()=>void):Promise<Submission> {
    return this.enqueue(id,async()=>{
      guard();const entries=this.submissions.get(id)??[];const found=entries.find(item=>item.requestId===requestId);
      if(!found||found.status!=='queued')throw new Error('QUEUED_MESSAGE_NOT_FOUND');
      const next={...found,...patch,requestId:found.requestId,sessionId:found.sessionId,updatedAt:Math.max(Date.now(),found.updatedAt+1)};
      const updated=entries.map(item=>item===found?next:item);guard();await atomicPrivateWrite(path.join(this.directory(id),'requests.json'),JSON.stringify(updated));this.submissions.set(id,updated);return structuredClone(next);
    });
  }
  /** Compare snapshots and commit a whole queue edit at one durable boundary.
   * In particular, a merge must never remove its source rows before the new
   * body is saved. Runtime consumption is checked by the host guard here. */
  compareAndEditQueued(id: string, expected: readonly Submission[], edits: ReadonlyArray<{ requestId: string; patch: QueuedSubmissionPatch }>,
    guard: () => void): Promise<Submission[] | null> {
    return this.enqueue(id, async () => {
      guard();
      const entries = this.submissions.get(id) ?? [];
      if (expected.length !== edits.length || new Set(edits.map(edit => edit.requestId)).size !== edits.length
        || edits.some(edit => !expected.some(row => row.requestId === edit.requestId))) throw new Error('INVALID_QUEUE_MUTATION');
      if (expected.some(snapshot => {
        const current = entries.find(row => row.requestId === snapshot.requestId);
        return !current || current.status !== 'queued' || JSON.stringify(current) !== JSON.stringify(snapshot);
      })) return null;
      const changed: Submission[] = [];
      const updated = entries.map(row => {
        const edit = edits.find(edit => edit.requestId === row.requestId);
        if (!edit) return row;
        // A monotonic timestamp also fences two edits within one clock tick.
        const next = { ...row, ...edit.patch, updatedAt: Math.max(Date.now(), row.updatedAt + 1) };
        changed.push(next); return next;
      });
      guard();
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(updated));
      this.submissions.set(id, updated);
      return structuredClone(changed);
    });
  }
  reorderQueued(id:string,requestIds:string[],guard:()=>void):Promise<void> {
    return this.enqueue(id,async()=>{
      guard();const entries=this.submissions.get(id)??[];const pending=entries.filter(item=>item.status==='queued');
      if(requestIds.length!==pending.length||new Set(requestIds).size!==pending.length||requestIds.some(id=>!pending.some(item=>item.requestId===id)))throw new Error('QUEUE_CHANGED');
      const byId=new Map(pending.map(item=>[item.requestId,item]));let index=0;
      const updated=entries.map(item=>item.status==='queued'?byId.get(requestIds[index++])!:item);
      guard();await atomicPrivateWrite(path.join(this.directory(id),'requests.json'),JSON.stringify(updated));this.submissions.set(id,updated);
    });
  }
  updateSubmission(id: string, requestId: string, status: Submission['status'], error?: string, finalText?: string): Promise<Submission> {
    return this.enqueue(id, async () => {
      const entries = this.submissions.get(id) ?? [];
      const found = entries.find(item => item.requestId === requestId);
      if (!found) throw new Error('SUBMISSION_NOT_FOUND');
      // A fast native adapter can finish before send() returns its acceptance.
      if (['completed', 'failed', 'interrupted'].includes(found.status)) return structuredClone(found);
      const receipt = { ...found, status, updatedAt: Date.now(), error, ...(finalText === undefined ? {} : { finalText }) };
      const next = entries.map(item => item === found ? receipt : item);
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(next));
      this.submissions.set(id, next);
      return structuredClone(receipt);
    });
  }
  async flush(): Promise<void> { await Promise.all([this.metadataBarrier, ...this.writes.values()]); if (this.routeFaults.size) throw this.routeFaults.values().next().value; }
}
