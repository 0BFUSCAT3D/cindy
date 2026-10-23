import type { Schedule, ScheduleRun, ScheduleStorage, ListFilter } from '@cindy/maker-scheduler';
import path from 'node:path';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';

type State = { version: 1; schedules: Schedule[]; runs: ScheduleRun[] };
/** The daemon's exclusive profile lock owns this file; every mutation is one
 * serialized atomic snapshot, including due-fire compare-and-swap. */
export class TerminalScheduleStorage implements ScheduleStorage {
  private state: State = { version: 1, schedules: [], runs: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(profileDir: string) { this.file = path.join(profileDir, 'schedules.json'); }
  async open() {
    const raw = await readPrivateFile(this.file);
    if (!raw) return;
    const value = JSON.parse(raw.toString()) as State;
    if (value.version !== 1 || !Array.isArray(value.schedules) || !Array.isArray(value.runs)) throw new Error('INVALID_SCHEDULE_STORAGE');
    this.state = value;
  }
  private mutate<T>(fn: (state: State) => T): Promise<T> {
    const result = this.pending.then(async () => { const next = structuredClone(this.state); const value = fn(next); await atomicPrivateWrite(this.file, JSON.stringify(next)); this.state = next; return structuredClone(value); });
    this.pending = result.catch(() => undefined); return result;
  }
  async list(filter?: ListFilter) { await this.pending; return structuredClone(this.state.schedules.filter(s => !filter?.status || s.status === filter.status)); }
  listActive() { return this.list({ status: 'active' }); }
  async get(id: string) { await this.pending; return structuredClone(this.state.schedules.find(s => s.id === id) ?? null); }
  insert(schedule: Schedule) { return this.mutate(s => { if (s.schedules.some(item => item.id === schedule.id)) throw new Error('SCHEDULE_EXISTS'); s.schedules.push(schedule); return schedule; }); }
  update(id: string, patch: Partial<Schedule>) { return this.mutate(s => { const index = s.schedules.findIndex(item => item.id === id); if (index < 0) return null; return s.schedules[index] = { ...s.schedules[index], ...patch, id }; }); }
  delete(id: string) { return this.mutate(s => { s.schedules = s.schedules.filter(item => item.id !== id); s.runs = s.runs.filter(item => item.scheduleId !== id); }); }
  claimDueFire(id: string, at: number) { return this.mutate(s => { const schedule = s.schedules.find(item => item.id === id); if (!schedule || schedule.status !== 'active' || schedule.nextFireAt !== at) return null; schedule.nextFireAt = undefined; return schedule; }); }
  insertRun(run: ScheduleRun) { return this.mutate(s => { if (s.runs.some(item => item.id === run.id)) throw new Error('SCHEDULE_RUN_EXISTS'); s.runs.push(run); return run; }); }
  updateRun(id: string, patch: Partial<ScheduleRun>) { return this.mutate(s => { const index = s.runs.findIndex(item => item.id === id); if (index < 0) return null; return s.runs[index] = { ...s.runs[index], ...patch, id }; }); }
  async listRuns(id: string, limit = 100) { await this.pending; return structuredClone(this.state.runs.filter(run => run.scheduleId === id).sort((a,b) => b.firedAt - a.firedAt).slice(0, Math.max(1, limit))); }
  deleteRun(id: string, options?: { excludeBotSchedules?: boolean }) { return this.mutate(s => { const row = s.runs.find(run => run.id === id); if (!row || options?.excludeBotSchedules && s.schedules.some(schedule => schedule.id === row.scheduleId && schedule.source === 'bot')) return null; s.runs = s.runs.filter(run => run.id !== id); return row; }); }
  markRunningAsInterrupted(before: number, excluded: readonly string[] = [], opts?: { legacyStaleBefore?: number }) { return this.mutate(s => { const changed = new Set<string>(); for (const run of s.runs) if (run.status === 'running' && !excluded.includes(run.id) && (run.heartbeatAt ?? run.firedAt) < (run.heartbeatAt === undefined ? opts?.legacyStaleBefore ?? before : before)) { run.status = 'interrupted'; run.finishedAt = Date.now(); changed.add(run.scheduleId); } return [...changed]; }); }
  touchRunHeartbeats(ids: readonly string[], at: number) { return this.mutate(s => { for (const run of s.runs) if (run.status === 'running' && ids.includes(run.id)) run.heartbeatAt = at; }); }
  async hasRunningRuns(id?: string) { await this.pending; return this.state.runs.some(run => run.status === 'running' && (!id || run.scheduleId === id)); }
  async allRuns() { await this.pending; return structuredClone(this.state.runs); }
  async flush() { await this.pending; }
}
