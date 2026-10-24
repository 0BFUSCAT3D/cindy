import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrcaWorkerStatus } from '@cindy/orca-workflow/host/orcaTeamService';
import type { OrcaRemotePendingReport, OrcaRemoteWorkerProxySessionSeed } from '@cindy/maker-shared/orca-remote-worker';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { NewTerminalTaskMeta, TerminalTaskMeta, TerminalTaskStorage } from './storage.js';
import { DEFAULT_ORCA_WORKER_PERMISSION_MODE, ORCA_WORKER_PERMISSION_MODES } from '@cindy/maker-shared/orca-worker-permission-mode';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.number().finite().nonnegative();
const teamSchema = z.object({ id: identifier, leadSessionId: identifier,
  status: z.enum(['active', 'completed', 'cancelled', 'failed']), completedAt: timestamp.nullable(),
  createdAt: timestamp, updatedAt: timestamp });
const workerSchema = z.object({ id: identifier, teamId: identifier, sessionId: identifier,
  status: z.enum(['idle', 'running', 'done', 'error']), label: z.string().nullable(),
  worktreeBranch: z.string().nullable(), role: z.string(), focused: z.boolean(), idleSince: timestamp.nullable(),
  executionDeviceId: z.string().nullable(), remoteSessionId: identifier.nullable(),
  lastBridgedMessageId: z.string().nullable(), pendingReport: z.object({ clientIds: z.array(z.string().min(1)).min(1).max(64), baselineMessageId: z.string().nullable() }).nullable(),
  remoteStopConfirmedAt: timestamp.nullable(), remoteReleasedAt: timestamp.nullable(),
  createdAt: timestamp, updatedAt: timestamp });
const taskPatchSchema = z.object({ archived: z.boolean().optional(), orcaRole: z.enum(['lead', 'worker']).nullable().optional() }).strict();
const proxySeedSchema = z.object({ title: z.string(), agentKind: z.enum(['cc', 'claude-code', 'codex', 'pi']),
  model: z.string(), effort: z.string().nullable(), permissionMode: z.string(),
  fastMode: z.union([z.boolean(), z.literal('ultrafast')]), agentDeviceId: z.string().nullable().optional() });
const journalSchema = z.object({ id: identifier, patch: taskPatchSchema, create: proxySeedSchema.optional() });
const settingsSchema = z.object({ workerSoftLimit: z.number().int().min(1).max(20), workerHardLimit: z.number().int().min(1).max(20),
  workerPermissionMode: z.enum(ORCA_WORKER_PERMISSION_MODES), workerIdleReleaseMinutes: z.number().int().min(0).max(120).default(0) }).refine(value => value.workerSoftLimit <= value.workerHardLimit);
const defaultSettings = { workerSoftLimit: 5, workerHardLimit: 8, workerIdleReleaseMinutes: 0, workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE };
const stateSchema = z.object({ version: z.literal(1), teams: z.array(teamSchema), workers: z.array(workerSchema),
  reservations: z.array(z.object({ id: identifier, teamId: identifier, label: z.string(), createdAt: timestamp, expiresAt: timestamp })),
  remoteOpens: z.array(z.object({ deviceId: z.string(), remoteSessionId: identifier, createdAt: timestamp })),
  taskJournal: z.array(journalSchema), settings: settingsSchema.default(defaultSettings) });
type State = z.infer<typeof stateSchema>;
type Team = z.infer<typeof teamSchema>;
type Worker = z.infer<typeof workerSchema>;
type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TerminalOrcaTeam = Omit<Team, 'completedAt' | 'createdAt' | 'updatedAt'> & {
  completedAt: string | null; createdAt: string; updatedAt: string;
};
export type TerminalOrcaWorker = Omit<Worker, 'idleSince' | 'createdAt' | 'updatedAt' | 'executionDeviceId' | 'remoteSessionId' | 'pendingReport' | 'lastBridgedMessageId' | 'remoteStopConfirmedAt' | 'remoteReleasedAt'> & {
  leadSessionId: string; idleSince: string | null; createdAt: string; updatedAt: string;
  session: { id: string; title: string; agentKind: TerminalTaskMeta['agentKind']; workingDir: string;
    model: string; effort: string; permissionMode: string; fastMode: boolean | 'ultrafast'; sdkSessionId?: string; agentDeviceId: string | null };
  executionDevice?: { deviceId: string; remoteSessionId: string; deviceName?: string; reachable?: boolean; workingDir?: string };
};
export interface TerminalOrcaRemoteWorker {
  workerId: string; teamId: string; leadSessionId: string; proxySessionId: string; deviceId: string;
  remoteSessionId: string; lastBridgedMessageId: string | null; pendingReport: OrcaRemotePendingReport | null;
  remoteStopConfirmedAt: number | null;
}
type ReservationResult = { ok: true; occupiedSlotsBefore: number } | { ok: false;
  errorCode: 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'WORKER_LIMIT_HARD_EXCEEDED' };
const active = (row: TerminalTaskMeta | undefined) => !!row && !row.archived && !row.deleted;
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const teamRecord = (row: Team): TerminalOrcaTeam => ({ ...row, completedAt: iso(row.completedAt),
  createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });

/** The profile service owns the only writer (the profile lifecycle lock also
 * excludes maintenance). One private commit contains team membership, leases,
 * remote receipts and task changes. Task metadata is materialized from that
 * commit before any reader or service can observe it, and replayed at startup.
 * No second collaboration lifecycle lives here: the shared Orca services own it. */
export class TerminalOrcaStore {
  readonly ready: Promise<void>;
  private state: State = { version: 1, teams: [], workers: [], reservations: [], remoteOpens: [], taskJournal: [], settings: { ...defaultSettings } };
  private tail: Promise<unknown>;
  private fault: unknown;
  private closed = false;
  private readonly file: string;
  private remoteStatus?: (sessionId: string, deviceId: string) => { deviceName: string; reachable: boolean; workingDir?: string } | undefined;
  constructor(private readonly options: { root: string; tasks: TerminalTaskStorage; guard(): void; beforeOpen?: Promise<void>;
    onTaskPatch?(id: string, patch: TaskPatch): void; now?: () => number }) {
    this.file = path.join(options.root, 'orca', 'state.json');
    this.ready = this.open().catch(error => { this.fault = error; throw error; }); this.tail = this.ready;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private guard() {
    if (this.closed) throw new Error('ORCA_STORE_CLOSED');
    if (this.fault) throw this.fault;
    this.options.guard();
  }
  private async open() {
    await this.options.beforeOpen;
    await privateDirectory(path.dirname(this.file));
    this.guard();
    const bytes = await readPrivateFile(this.file);
    if (bytes) this.state = stateSchema.parse(JSON.parse(bytes.toString()));
    this.validate(this.state);
    await this.materialize(this.state);
  }
  private validate(state: State) {
    const unique = (values: string[]) => { if (new Set(values).size !== values.length) throw new Error('ORCA_STORE_CONFLICT'); };
    unique(state.teams.map(row => row.id)); unique(state.workers.map(row => row.id));
    unique(state.workers.map(row => row.sessionId)); unique(state.reservations.map(row => row.id));
    unique(state.teams.filter(row => row.status === 'active').map(row => row.leadSessionId));
    unique(state.workers.filter(row => row.label !== null).map(row => JSON.stringify([row.teamId, row.label!.toLowerCase()])));
    unique(state.workers.filter(row => row.focused).map(row => row.teamId));
    unique(state.reservations.map(row => JSON.stringify([row.teamId, row.label.toLowerCase()])));
    unique(state.remoteOpens.map(row => row.remoteSessionId));
    const teams = new Set(state.teams.map(row => row.id));
    if ([...state.workers, ...state.reservations].some(row => !teams.has(row.teamId))) throw new Error('ORCA_TEAM_NOT_FOUND');
    if (state.workers.some(row => !!row.executionDeviceId !== !!row.remoteSessionId)) throw new Error('ORCA_REMOTE_ROUTE_INVALID');
  }
  private async materialize(state: State) {
    if (!state.taskJournal.length) return;
    for (const entry of state.taskJournal) {
      this.guard();
      let row = await this.options.tasks.get(entry.id);
      if (!row && entry.create) {
        const seed = entry.create;
        row = await this.options.tasks.create({ id: entry.id, title: seed.title, agentKind: seed.agentKind === 'cc' ? 'claude-code' : seed.agentKind,
          model: seed.model, effort: seed.effort ?? undefined, permissionMode: seed.permissionMode as TerminalTaskMeta['permissionMode'],
          fastMode: seed.fastMode, agentDeviceId: seed.agentDeviceId ?? undefined,
          workDir: '', workspaceKind: 'project', ...entry.patch } as NewTerminalTaskMeta, () => this.guard());
      }
      // A deleted task is never resurrected by a journal replay.
      if (row && !row.deleted) {
        await this.options.tasks.updateIf(entry.id, candidate => !candidate.deleted, entry.patch, () => this.guard());
        this.options.onTaskPatch?.(entry.id, entry.patch);
      }
    }
    this.guard();
    const complete = { ...state, taskJournal: [] };
    await atomicPrivateWrite(this.file, JSON.stringify(complete));
    this.state = complete;
  }
  private run<T>(operation: (state: State, tasks: Map<string, TerminalTaskMeta>) => T, write = false): Promise<T> {
    const result = this.tail.then(async () => {
      this.guard();
      const tasks = new Map((await this.options.tasks.list()).map(row => [row.id, row]));
      this.guard();
      const state = write ? structuredClone(this.state) : this.state;
      const value = operation(state, tasks);
      if (write) {
        stateSchema.parse(state); this.validate(state); this.guard();
        try {
          await atomicPrivateWrite(this.file, JSON.stringify(state));
          this.state = state;
          await this.materialize(state);
        } catch (error) {
          // A failed acknowledgement may follow the atomic rename. Never let
          // a later write replace that committed receipt with our old snapshot.
          this.fault = error; throw error;
        }
      }
      return structuredClone(value);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private patch(state: State, id: string, patch: TaskPatch) { state.taskJournal.push({ id, patch }); }
  private workerRecord(row: Worker, team: Team, task: TerminalTaskMeta): TerminalOrcaWorker {
    const { executionDeviceId: _device, remoteSessionId: _remote, pendingReport: _pending,
      lastBridgedMessageId: _message, remoteStopConfirmedAt: _stopped, remoteReleasedAt: _released, ...visible } = row;
    return { ...visible, leadSessionId: team.leadSessionId, idleSince: iso(row.idleSince),
      createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
      session: { id: task.id, title: task.title ?? '', agentKind: task.agentKind, workingDir: task.workDir,
        model: task.model, effort: task.effort ?? '', permissionMode: task.permissionMode ?? 'ask', fastMode: task.fastMode ?? false,
        sdkSessionId: task.sdkSessionId, agentDeviceId: task.agentDeviceId ?? null },
      ...(row.executionDeviceId && row.remoteSessionId ? { executionDevice: { deviceId: row.executionDeviceId,
        remoteSessionId: row.remoteSessionId, ...this.remoteStatus?.(row.sessionId, row.executionDeviceId) } } : {}) };
  }
  setRemoteWorkerStatusProvider(provider: typeof this.remoteStatus) { this.remoteStatus = provider; }
  settings() { this.guard(); return { ...this.state.settings }; }
  idleCandidates(before: number) { return this.run((state, tasks) => state.workers.flatMap(worker => {
    const team = state.teams.find(team => team.id === worker.teamId && team.status === 'active');
    return team && active(tasks.get(worker.sessionId)) && !worker.executionDeviceId && worker.idleSince === null && worker.updatedAt < before
      ? [{ id: worker.id, sessionId: worker.sessionId, leadSessionId: team.leadSessionId, status: worker.status, idleSince: worker.idleSince, updatedAt: worker.updatedAt }] : [];
  })); }
  markIdleReleased(expected: { id: string; status: string; updatedAt: number }, at: number) { return this.run(state => {
    const row = state.workers.find(worker => worker.id === expected.id && worker.idleSince === null && worker.status === expected.status && worker.updatedAt === expected.updatedAt);
    if (!row) return false;
    row.status = 'idle'; row.idleSince = at; row.updatedAt = at; return true;
  }, true); }
  touchWorker(id: string, at: number) { return this.run(state => { const row = state.workers.find(worker => worker.id === id); if (row) row.updatedAt = at; }, true); }
  updateSettings(patch: Partial<z.infer<typeof settingsSchema>>) { return this.run(state => {
    state.settings = settingsSchema.parse({ ...state.settings, ...patch });
    return { ...state.settings };
  }, true); }
  getTeamByLeadSession(lead: string) { return this.run(state => { const row = state.teams.find(team => team.leadSessionId === lead); return row ? teamRecord(row) : null; }); }
  getActiveTeamByLead(lead: string) { return this.run(state => { const row = state.teams.find(team => team.leadSessionId === lead && team.status === 'active'); return row ? teamRecord(row) : null; }); }
  getTeamByWorkerSession(id: string) { return this.run(state => { const worker = state.workers.find(row => row.sessionId === id), team = state.teams.find(row => row.id === worker?.teamId); return team ? teamRecord(team) : null; }); }
  createActiveTeam(input: { id?: string; leadSessionId: string }) {
    return this.run((state, tasks) => {
      if (!active(tasks.get(input.leadSessionId))) throw new Error('TASK_NOT_FOUND');
      const now = this.now(), row: Team = { id: input.id ?? randomUUID(), leadSessionId: input.leadSessionId,
        status: 'active', completedAt: null, createdAt: now, updatedAt: now };
      state.teams.push(row); return teamRecord(row);
    }, true);
  }
  isOrphanedTeamInit(id: string) { return this.run(state => {
    const team = state.teams.find(row => row.id === id), now = this.now();
    return !!team && now - team.createdAt >= 60_000 && !state.workers.some(row => row.teamId === id)
      && !state.reservations.some(row => row.teamId === id && row.expiresAt > now);
  }); }
  markTeamEnded(id: string, status: Exclude<Team['status'], 'active'>) { return this.run(state => {
    const row = state.teams.find(team => team.id === id); if (row) Object.assign(row, { status, completedAt: this.now(), updatedAt: this.now() });
  }, true); }
  setSessionOrcaRole(id: string, role: 'lead' | 'worker' | null) { return this.run(state => this.patch(state, id, { orcaRole: role }), true); }
  getSessionOrcaRole(id: string) { return this.run((_state, tasks) => tasks.get(id)?.orcaRole ?? null); }
  reserveWorkerCreation(input: { reservationId: string; teamId: string; label: string; hardLimit: number; leaseMs: number }): Promise<ReservationResult> {
    return this.run((state, tasks): ReservationResult => {
      const now = this.now(), label = input.label.toLowerCase();
      state.reservations = state.reservations.filter(row => row.expiresAt > now);
      if (state.workers.some(row => row.teamId === input.teamId && row.label?.toLowerCase() === label)) return { ok: false, errorCode: 'DUPLICATE_LABEL' };
      if (state.reservations.some(row => row.teamId === input.teamId && row.label === label)) return { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' };
      const occupiedSlotsBefore = state.workers.filter(row => row.teamId === input.teamId && active(tasks.get(row.sessionId))).length
        + state.reservations.filter(row => row.teamId === input.teamId).length;
      if (occupiedSlotsBefore >= input.hardLimit) return { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' };
      state.reservations.push({ id: input.reservationId, teamId: input.teamId, label, createdAt: now, expiresAt: now + input.leaseMs });
      return { ok: true, occupiedSlotsBefore };
    }, true);
  }
  renewWorkerCreationReservation(id: string, leaseMs: number) { return this.run(state => {
    const now = this.now(), row = state.reservations.find(item => item.id === id && item.expiresAt > now);
    if (!row) return false; row.expiresAt = now + leaseMs; return true;
  }, true); }
  releaseWorkerCreationReservation(id: string) { return this.run(state => { state.reservations = state.reservations.filter(row => row.id !== id); }, true); }
  private upsert(state: State, input: { id: string; teamId: string; sessionId: string; status?: OrcaWorkerStatus;
    label?: string | null; worktreeBranch?: string | null; role?: string; focused?: boolean; idleSince?: number | null }) {
    if (!state.teams.some(row => row.id === input.teamId && row.status === 'active')) throw new Error('ORCA_TEAM_NOT_FOUND');
    if (input.focused) for (const row of state.workers) if (row.teamId === input.teamId) row.focused = false;
    let worker = state.workers.find(row => row.id === input.id || row.sessionId === input.sessionId);
    const now = this.now();
    const updates = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    if (worker) Object.assign(worker, updates, { updatedAt: now });
    else { worker = { id: input.id, teamId: input.teamId, sessionId: input.sessionId, status: 'idle', label: null,
      worktreeBranch: null, role: 'developer', focused: false, idleSince: null, executionDeviceId: null,
      remoteSessionId: null, lastBridgedMessageId: null, pendingReport: null, remoteReleasedAt: null,
      remoteStopConfirmedAt: null, createdAt: now, updatedAt: now, ...updates }; state.workers.push(worker); }
    if (worker.label !== null) worker.label = worker.label.toLowerCase();
    this.patch(state, input.sessionId, { orcaRole: 'worker' });
    return worker;
  }
  async addOrUpdateWorker(input: Parameters<TerminalOrcaStore['upsert']>[1]): Promise<TerminalOrcaWorker> {
    await this.run((state, tasks) => { if (!active(tasks.get(input.sessionId))) throw new Error('TASK_NOT_FOUND'); this.upsert(state, input); }, true);
    const worker = await this.run((state, tasks) => { const row = state.workers.find(item => item.id === input.id || item.sessionId === input.sessionId)!;
      return this.workerRecord(row, state.teams.find(team => team.id === row.teamId)!, tasks.get(row.sessionId)!); });
    return worker;
  }
  async listWorkersByLead(lead: string) { return (await this.listWorkersByLeads([lead]))[lead] ?? []; }
  workerForLead(leadId: string, workerId: string) { return this.run((state, tasks) => {
    const worker = state.workers.find(row => row.id === workerId), team = state.teams.find(row => row.id === worker?.teamId && row.leadSessionId === leadId);
    const task = worker && tasks.get(worker.sessionId);
    return worker && team && task && !task.deleted ? this.workerRecord(worker, team, task) : null;
  }); }
  occupiedSlots(teamId: string) { return this.run((state, tasks) =>
    state.workers.filter(row => row.teamId === teamId && active(tasks.get(row.sessionId))).length
    + state.reservations.filter(row => row.teamId === teamId && row.expiresAt > this.now()).length); }
  listWorkersByLeads(leads: readonly string[]) { return this.run((state, tasks) => {
    const result: Record<string, TerminalOrcaWorker[]> = Object.fromEntries([...new Set(leads)].map(id => [id, []]));
    for (const row of state.workers) {
      const team = state.teams.find(team => team.id === row.teamId && team.status === 'active'), task = tasks.get(row.sessionId);
      if (team && Object.hasOwn(result, team.leadSessionId) && active(task)) result[team.leadSessionId]!.push(this.workerRecord(row, team, task!));
    }
    for (const workers of Object.values(result)) workers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return result;
  }); }
  getWorkerLink(input: { workerId?: string; workerSessionId?: string }) { return this.run((state, tasks) => {
    if (!input.workerId && !input.workerSessionId) return null;
    const worker = state.workers.find(row => (!input.workerId || row.id === input.workerId) && (!input.workerSessionId || row.sessionId === input.workerSessionId));
    const team = state.teams.find(row => row.id === worker?.teamId), lead = team && tasks.get(team.leadSessionId);
    if (!worker || !team || !lead) return null;
    return { workerId: worker.id, teamId: team.id, workerSessionId: worker.sessionId, leadSessionId: lead.id,
      leadSession: { sessionId: lead.id, agentKind: lead.agentKind, workingDir: lead.workDir, model: lead.model,
        providerId: lead.providerId ?? null, effort: lead.effort ?? '', permissionMode: lead.permissionMode ?? 'ask',
        fastMode: lead.fastMode ?? false, sdkSessionId: lead.sdkSessionId, title: lead.title ?? '', remoteHostId: null } };
  }); }
  updateWorkerStatus(id: string, status: OrcaWorkerStatus) { return this.run(state => { const row = state.workers.find(row => row.id === id);
    if (row) { row.status = status; row.updatedAt = this.now(); if (status === 'running') row.idleSince = null; }
  }, true); }
  markWorkerIdleIfStatus(id: string, expected: OrcaWorkerStatus) { return this.run(state => {
    const row = state.workers.find(row => row.id === id && row.status === expected); if (!row) return false;
    Object.assign(row, { status: 'idle', idleSince: this.now(), updatedAt: this.now() }); return true;
  }, true); }
  markWorkerIdle(id: string) { return this.run(state => {
    const row = state.workers.find(row => row.id === id);
    if (row) Object.assign(row, { status: 'idle', idleSince: this.now(), updatedAt: this.now() });
  }, true); }
  restoreWorkerDoneIfIdle(id: string) { return this.run(state => { const row = state.workers.find(row => row.id === id && row.status === 'idle');
    if (!row) return false; Object.assign(row, { status: 'done', idleSince: null, updatedAt: this.now() }); return true;
  }, true); }
  setWorkerFocus(teamId: string, id: string) { return this.run(state => {
    if (!state.workers.some(row => row.id === id && row.teamId === teamId)) throw new Error('ORCA_WORKER_NOT_FOUND');
    for (const row of state.workers) if (row.teamId === teamId) { row.focused = row.id === id; row.updatedAt = this.now(); }
  }, true); }
  removeWorker(id: string) { return this.run((state, tasks) => {
    const row = state.workers.find(row => row.id === id); if (!row) return;
    if (row.executionDeviceId && row.remoteReleasedAt === null) { row.label = null; row.updatedAt = this.now(); }
    else state.workers = state.workers.filter(worker => worker.id !== id);
    if (tasks.has(row.sessionId)) this.patch(state, row.sessionId, { archived: true, orcaRole: null });
  }, true); }
  archiveWorkersByTeam(teamId: string) { return this.run((state, tasks) => {
    const ids = state.workers.filter(row => row.teamId === teamId && active(tasks.get(row.sessionId))).map(row => row.sessionId);
    for (const id of ids) this.patch(state, id, { archived: true }); return ids;
  }, true); }
  reconcileInactiveTeamWorkersForLead(lead: string) { return this.run((state, tasks) => {
    const teams = new Set(state.teams.filter(row => row.leadSessionId === lead && row.status !== 'active').map(row => row.id));
    for (const row of state.workers) if (teams.has(row.teamId)) { row.status = 'done'; row.updatedAt = this.now(); }
    const ids = state.workers.filter(row => teams.has(row.teamId) && active(tasks.get(row.sessionId))).map(row => row.sessionId);
    for (const id of ids) this.patch(state, id, { archived: true }); return ids;
  }, true); }
  markWorkerStatusesByTeam(teamId: string, status: OrcaWorkerStatus) { return this.run(state => {
    for (const row of state.workers) if (row.teamId === teamId) { row.status = status; row.updatedAt = this.now(); }
  }, true); }
  addRemoteWorker(input: { workerId: string; teamId: string; proxySessionId: string; deviceId: string;
    remoteSessionId: string; label: string; role: string; proxySession?: OrcaRemoteWorkerProxySessionSeed }) {
    return this.run((state, tasks) => {
      if (tasks.has(input.proxySessionId) && input.proxySession) throw new Error('TASK_ALREADY_EXISTS');
      if (!tasks.has(input.proxySessionId) && !input.proxySession) throw new Error('TASK_NOT_FOUND');
      if (input.proxySession) state.taskJournal.push({ id: input.proxySessionId, patch: { orcaRole: 'worker' }, create: proxySeedSchema.parse(input.proxySession) });
      const row = this.upsert(state, { id: input.workerId, teamId: input.teamId, sessionId: input.proxySessionId, label: input.label, role: input.role, status: 'idle', focused: false });
      row.executionDeviceId = input.deviceId; row.remoteSessionId = input.remoteSessionId;
      state.remoteOpens = state.remoteOpens.filter(row => row.remoteSessionId !== input.remoteSessionId);
    }, true);
  }
  saveWorkerRemoteReport(id: string, pending: OrcaRemotePendingReport | null, messageId?: string, markDone = false) { return this.run(state => {
    const row = state.workers.find(row => row.id === id); if (!row) return;
    row.pendingReport = structuredClone(pending); if (messageId) row.lastBridgedMessageId = messageId;
    if (markDone) { row.status = 'done'; row.updatedAt = this.now(); }
  }, true); }
  saveRemoteWorkerOpen(deviceId: string, remoteSessionId: string) { return this.run(state => { state.remoteOpens.push({ deviceId, remoteSessionId, createdAt: this.now() }); }, true); }
  removeRemoteWorkerOpen(id: string) { return this.run(state => { state.remoteOpens = state.remoteOpens.filter(row => row.remoteSessionId !== id); }, true); }
  listOrphanRemoteWorkerOpens(id?: string) { return this.run(state => state.remoteOpens.filter(row => (!id || row.remoteSessionId === id)
    && !state.workers.some(worker => worker.remoteSessionId === row.remoteSessionId && worker.executionDeviceId === row.deviceId))); }
  markWorkerRemoteStopConfirmed(id: string, at = this.now()) { return this.run(state => { const row = state.workers.find(row => row.id === id); if (row) row.remoteStopConfirmedAt = at; }, true); }
  markWorkerRemoteReleased(id: string, at = this.now()) { return this.run(state => { const row = state.workers.find(row => row.id === id); if (row) row.remoteReleasedAt = at; }, true); }
  getWorkerRemoteReleaseState(id: string) { return this.run((state, tasks) => {
    const row = state.workers.find(row => row.id === id), task = row && tasks.get(row.sessionId); return row && task
      ? { remoteStopConfirmedAt: row.remoteStopConfirmedAt, remoteReleasedAt: row.remoteReleasedAt, removeAfterRelease: !active(task) && !task.orcaRole } : null;
  }); }
  private remoteRow(row: Worker, team: Team): TerminalOrcaRemoteWorker | null { return row.executionDeviceId && row.remoteSessionId
    ? { workerId: row.id, teamId: row.teamId, leadSessionId: team.leadSessionId, proxySessionId: row.sessionId,
      deviceId: row.executionDeviceId, remoteSessionId: row.remoteSessionId, lastBridgedMessageId: row.lastBridgedMessageId,
      pendingReport: row.pendingReport, remoteStopConfirmedAt: row.remoteStopConfirmedAt } : null; }
  listActiveRemoteWorkers() { return this.run((state, tasks) => state.workers.flatMap(row => {
    const team = state.teams.find(team => team.id === row.teamId), remote = team && this.remoteRow(row, team);
    return remote && team?.status === 'active' && active(tasks.get(row.sessionId)) ? [remote] : [];
  })); }
  listUnreleasedEndedRemoteWorkers() { return this.run((state, tasks) => state.workers.flatMap(row => {
    const team = state.teams.find(team => team.id === row.teamId), remote = team && this.remoteRow(row, team);
    return remote && row.remoteReleasedAt === null && (team?.status !== 'active' || !active(tasks.get(row.sessionId))) ? [remote] : [];
  })); }
  getRemoteWorkerByProxySession(id: string) { return this.run(state => { const row = state.workers.find(row => row.sessionId === id), team = state.teams.find(team => team.id === row?.teamId);
    return row && team ? this.remoteRow(row, team) : null;
  }); }
  async flush() { await this.tail; this.guard(); }
  async close() { await this.tail.catch(() => undefined); this.closed = true; }
}
