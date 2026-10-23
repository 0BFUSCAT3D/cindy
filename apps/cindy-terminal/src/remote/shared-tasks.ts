import path from 'node:path';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { TerminalRemoteAccountService } from './account.js';

type Entry = { sharedTaskId: string; sessionId: string };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** The original owner's cleanup capability and journal survive logout. No
 * credentials enter the journal, and a new account never performs old cleanup. */
export class TerminalSharedTasks {
  private readonly file: string;
  private readonly owner: string | null;
  private readonly cleanup: ReturnType<TerminalRemoteAccountService['captureSharedTaskCleanup']>;
  private readonly ready: Promise<void>;
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private readonly blocked = new Set<string>();
  private readonly creates = new Set<Promise<unknown>>();
  private writes: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private loaded = false;
  constructor(private readonly options: {
    profileDir: string; account: TerminalRemoteAccountService;
    getOwnerScope(): string | null; deviceId: string;
    readTask(id: string): Promise<{archived?:boolean;deleted?:boolean}|null>;
    revoke(sessionId: string): void;
  }) {
    this.file = path.join(options.profileDir, 'shared-task-cleanup.json');
    this.owner = options.getOwnerScope();
    this.cleanup = options.account.captureSharedTaskCleanup();
    // Initialization can happen while signed out; no unhandled rejection.
    void this.cleanup.catch(() => undefined);
    this.ready = this.load();
  }
  private assertCurrent() {
    if (this.closed || !this.owner || this.options.getOwnerScope() !== this.owner) throw new Error('OWNER_CHANGED');
  }
  private async load() {
    await privateDirectory(path.dirname(this.file));
    const bytes = await readPrivateFile(this.file);
    if (!bytes) { this.loaded=true; return; }
    const value = JSON.parse(bytes.toString()) as {version?:unknown;pending?:unknown;sessions?:unknown};
    if (value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > 10_000) throw new Error('INVALID_SHARED_TASK_JOURNAL');
    if (value.sessions !== undefined && (!Array.isArray(value.sessions) || value.sessions.some(id=>!validId(id)))) throw new Error('INVALID_SHARED_TASK_JOURNAL');
    for (const id of (value.sessions ?? []) as string[]) this.blocked.add(id);
    for (const row of value.pending as Entry[]) {
      if (!row || !validId(row.sharedTaskId) || !validId(row.sessionId)) throw new Error('INVALID_SHARED_TASK_JOURNAL');
      this.pending.set(row.sharedTaskId, row.sessionId); this.blocked.add(row.sessionId);
    }
    this.loaded=true;
  }
  private persist() {
    const job = this.writes.then(() => atomicPrivateWrite(this.file, JSON.stringify({version:1,sessions:[...this.blocked],pending:[...this.pending].map(([sharedTaskId,sessionId])=>({sharedTaskId,sessionId}))})));
    this.writes = job.catch(() => undefined); return job;
  }
  isBlocked(sessionId: string) { return !this.loaded || this.blocked.has(sessionId); }
  async open() {
    await this.ready; this.assertCurrent();
    const api = await this.cleanup;
    for (const item of await api.list()) {
      if (item.hostDeviceId !== this.options.deviceId) continue;
      this.known.set(item.sharedTaskId, item.sessionId);
      const task = await this.options.readTask(item.sessionId);
      if (!task || task.archived || task.deleted || this.blocked.has(item.sessionId)) await this.enqueue(item.sharedTaskId, item.sessionId);
    }
    await this.retry();
  }
  private async enqueue(sharedTaskId: string, sessionId: string) {
    this.blocked.add(sessionId); this.options.revoke(sessionId);
    this.pending.set(sharedTaskId, sessionId);
    await this.persist();
  }
  async create(sessionId: string, title: string) {
    await this.ready; this.assertCurrent();
    let committed: string | undefined;
    const job = (async () => {
      try {
        const value = await this.options.account.sharedTasks.create(sessionId, title, id => { committed = id; this.known.set(id,sessionId); });
        this.assertCurrent(); this.blocked.delete(sessionId); await this.persist(); return value;
      } catch (error) {
        if (committed) { await this.enqueue(committed,sessionId); await this.retry(); }
        throw error;
      }
    })();
    this.creates.add(job);
    try { return await job; } finally { this.creates.delete(job); }
  }
  async closeTask(sessionId: string) {
    await this.ready; this.assertCurrent();
    // Cover a share created on another same-account controller since open().
    this.blocked.add(sessionId); this.options.revoke(sessionId); await this.persist();
    const api = await this.cleanup;
    try { for (const item of await api.list()) if (item.hostDeviceId === this.options.deviceId) this.known.set(item.sharedTaskId,item.sessionId); } catch { /* close known shares now, discover missed ones at restart */ }
    this.assertCurrent();
    for (const [id, sid] of this.known) if (sid === sessionId) await this.enqueue(id,sid);
    await this.retry();
  }
  async closeShare(sharedTaskId: string, sessionId: string) {
    await this.ready; this.assertCurrent(); await this.enqueue(sharedTaskId,sessionId); await this.retry();
  }
  async logout() {
    await this.ready;
    await Promise.allSettled([...this.creates]);
    const api = await this.cleanup;
    // This fixed account capability may be used after the live auth fence moved.
    try { for (const item of await api.list()) if (item.hostDeviceId === this.options.deviceId) this.known.set(item.sharedTaskId,item.sessionId); } catch { /* known IDs still close */ }
    for (const [id,sid] of this.known) await this.enqueue(id,sid);
    await this.retry();
  }
  private async retry() {
    const api = await this.cleanup;
    for (const [id] of this.pending) {
      try { await api.close(id); this.pending.delete(id); this.known.delete(id); await this.persist(); } catch { /* persistent retry */ }
    }
    clearTimeout(this.timer);
    if (!this.closed && this.pending.size) { this.timer=setTimeout(()=>{void this.retry().catch(()=>undefined);},30_000);this.timer.unref(); }
  }
  async close() { this.closed=true;clearTimeout(this.timer);await this.writes; }
}
