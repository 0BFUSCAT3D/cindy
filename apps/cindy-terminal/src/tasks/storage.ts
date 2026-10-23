import { createReadStream } from 'node:fs';
import { open, readdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { SessionMeta, SessionStorage, AgentEvent, UserMessage } from '@cindy/maker-core';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { ModelSelection } from '../models/config.js';
import type { ImBindingRow } from '@cindy/im-runtime/binding';
import { validateImBindingRow } from '../im/bindings.js';

export type TerminalTaskMeta = SessionMeta & { providerId?: string; archived?: boolean; deleted?: boolean; pinnedAt?: number | null; agentDeviceId?: string; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding; queuePaused?: boolean; queueExpanded?: boolean; clearedAt?: number; source?: string; imBotContextId?: string; imUserId?: string; imScopeKey?: string; imDefaultRoute?: string | null; workspaceKind?: 'project' | 'dialogue'; userSendAt?: number; usage?: { tokenUsage: number; contextTokens: number; contextWindow: number; costUsd: number } };
export type NewTerminalTaskMeta = Omit<TerminalTaskMeta, 'createdAt' | 'updatedAt'>;
type ChannelRotation = { version: 1; rows: TerminalTaskMeta[]; bindings: ImBindingRow[] };
export type Submission = { requestId: string; sessionId: string; fingerprint: string; sendAtMs?: number; sender?: {sessionId:string;title?:string}; status: 'queued' | 'sending' | 'running' | 'completed' | 'failed' | 'interrupted'; createdAt: number; updatedAt: number; error?: string; finalText?: string; message?: UserMessage; source?: 'local' | 'remote'; deviceId?: string; sourceDevice?: import('../contracts.js').InvocationContext['sourceDevice']; ownerId?: string; deliveryProof?: import('./handoff.js').TaskDeliveryProof; scheduler?: {kind:'scheduler';scheduleId:string;scheduleName:string;runId:string;firedAt?:number}; sharedTask?: import('../contracts.js').InvocationContext['sharedTask'] };
export type HistoryRecord = { sequence: number; timestamp: number; kind: 'event' | 'user' | 'user-meta'; event?: AgentEvent; message?: UserMessage; origin?: 'local' | 'remote'; agentMeta?: Record<string, unknown>; clientId?: string };
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
      const raw = await readPrivateFile(this.file(entry.name));
      if (!raw) throw new Error('TASK_METADATA_MISSING');
      const row = JSON.parse(raw.toString()) as TerminalTaskMeta;
      if (row.id !== entry.name || !['claude-code', 'codex', 'pi'].includes(row.agentKind) || typeof row.model !== 'string' || typeof row.workDir !== 'string') throw new Error('INVALID_TASK_METADATA');
      this.rows.set(row.id, row);
      await this.repairInterruptedAppend(row.id);
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
    const result = Promise.all([this.metadataBarrier, this.writes.get(id)]).then(action);
    this.writes.set(id, result.catch(() => undefined));
    return result;
  }
  async create(meta: NewTerminalTaskMeta): Promise<TerminalTaskMeta> {
    return this.enqueue(meta.id, async () => {
      if (this.rows.has(meta.id)) throw new Error('TASK_ALREADY_EXISTS');
      await privateDirectory(this.directory(meta.id));
      const row = { ...meta, createdAt: Date.now(), updatedAt: Date.now() };
      await atomicPrivateWrite(this.file(meta.id), JSON.stringify(row));
      this.rows.set(meta.id, row);
      return structuredClone(row);
    });
  }
  async get(id: string): Promise<TerminalTaskMeta | null> {
    taskId(id);
    await this.metadataBarrier;
    await this.writes.get(id);
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
  delete(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      // Atomic rename is not needed for deletion: the host first closes the runtime.
      await rm(this.directory(id), { force: true, recursive: true });
      this.rows.delete(id);
      this.nextSequences.delete(id);
    });
  }
  setSelection(id: string, selection: ModelSelection) { return this.update(id, { agentKind: selection.agentKind, providerId: selection.providerId, model: selection.model, effort: selection.effort }); }
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
      const handle = await open(path.join(this.directory(id), 'events.jsonl'), 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      this.nextSequences.set(id, record.sequence);
      return record;
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
  claimSubmission(id: string, requestId: string, fingerprint: string, guard: () => void, payload?: Pick<Submission, 'message' | 'source' | 'deviceId' | 'sourceDevice' | 'ownerId' | 'sharedTask' | 'scheduler' | 'sendAtMs' | 'deliveryProof' | 'sender'>): Promise<{ receipt: Submission; created: boolean }> {
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
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify([...entries, receipt]));
      this.submissions.set(id, [...entries, receipt]);
      return { receipt: structuredClone(receipt), created: true };
    });
  }
  editQueuedSubmission(id:string,requestId:string,patch:Partial<Submission>,guard:()=>void):Promise<Submission> {
    return this.enqueue(id,async()=>{
      guard();const entries=this.submissions.get(id)??[];const found=entries.find(item=>item.requestId===requestId);
      if(!found||found.status!=='queued')throw new Error('QUEUED_MESSAGE_NOT_FOUND');
      const next={...found,...patch,requestId:found.requestId,sessionId:found.sessionId,updatedAt:Date.now()};
      const updated=entries.map(item=>item===found?next:item);guard();await atomicPrivateWrite(path.join(this.directory(id),'requests.json'),JSON.stringify(updated));this.submissions.set(id,updated);return structuredClone(next);
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
      const receipt = { ...found, status, updatedAt: Date.now(), ...(error ? { error } : {}), ...(finalText === undefined ? {} : { finalText }) };
      const next = entries.map(item => item === found ? receipt : item);
      await atomicPrivateWrite(path.join(this.directory(id), 'requests.json'), JSON.stringify(next));
      this.submissions.set(id, next);
      return structuredClone(receipt);
    });
  }
  async flush(): Promise<void> { await Promise.all([this.metadataBarrier, ...this.writes.values()]); }
}
