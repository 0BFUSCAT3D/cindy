import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoutineEngine, type Routine, type RoutineInput, type RoutineRun } from '@cindy/maker-scheduler';
import { RoutineFileStore } from '@cindy/maker-scheduler/routine-store';
import { buildRoutineSchedule, createCompanionRoutineTransfer } from '@cindy/companion-core/routines';
import { registerRoutineRemoteResources, type RoutineManagementTools } from '@cindy/companion-core/routineResources';
import type { RemoteResourceRegistry } from '@cindy/device-link';
import type { TerminalSchedulerHost } from '../../tasks/scheduler.js';
import type { TerminalCompanionHost } from './host.js';

/** The shared routine engine owns durable admission; the ordinary scheduler owns
 * checks, native turns, cancellation and run history, exactly as on Desktop. */
export class TerminalCompanionRoutines {
  readonly engine: RoutineEngine;
  readonly transfer: ReturnType<typeof createCompanionRoutineTransfer>;
  readonly service: RoutineManagementTools;
  private starting?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly host: TerminalCompanionHost, private readonly scheduler: TerminalSchedulerHost) {
    const store = new RoutineFileStore(path.join(host.options.root, 'routines'));
    this.engine = new RoutineEngine({ load: () => store.load(), save: state => store.save(state),
      id: randomUUID, now: Date.now,
      execute: (...args) => this.execute(...args),
      changed: () => { if (!this.closed) host.options.emit('maker:remote-resources:changed', [{ collectionId: 'routines' }]); },
      onError: () => host.options.logger.warn('COMPANION_ROUTINE_ERROR'),
    });
    this.service = {
      list: id => this.list(id), save: (id,input,key,revision) => this.save(id,input,key,revision),
      createOnce: (id,input,key) => this.createOnce(id,input,key), remove: (id,key,revision) => this.remove(id,key,revision),
      runNow: (id,key,revision) => this.runNow(id,key,revision),
      history: async (id,key) => { await this.check(id); if (!this.engine.list(id).some(row => row.id === key)) throw new Error('ROUTINE_NOT_FOUND'); return this.engine.history(key); },
      sources: async () => { await this.open(); this.guard(); return this.engine.listSources(); },
    };
    this.transfer = createCompanionRoutineTransfer(this.service);
  }
  registerResources(registry: RemoteResourceRegistry) { registerRoutineRemoteResources({registry,tools:this.service,
    getEngine:async () => { await this.open();this.guard();return this.engine; },
    listBots:async () => (await this.host.profiles.list()).map(row=>({...row,currentVersion:row.version})),
    scope:()=>{this.guard();return this.host.options.root;},boundaryPending:()=>this.closed,
  }); }
  private guard() { if (this.closed) throw new Error('COMPANION_ROUTINES_CLOSED'); this.host.options.guard(); }
  open(): Promise<void> {
    this.guard();
    this.starting ??= (async () => {
      await this.scheduler.ready;
      const profiles = await this.host.profiles.list();
      const states = new Map(profiles.map(profile => [profile.id,profile.status] as const));
      const store = new RoutineFileStore(path.join(this.host.options.root,'routines'));
      const saved = await store.load();
      const all = new Map<string,'active'|'paused'|'deleted'>(states);
      for (const routine of saved?.routines ?? []) if (!all.has(routine.botId)) all.set(routine.botId,'deleted');
      this.guard(); await this.engine.start(all); this.guard();
      this.timer = setInterval(() => { void this.engine.tick().catch(() => this.host.options.logger.warn('COMPANION_ROUTINE_TICK_FAILED')); },1000);
      this.timer.unref?.();
    })();
    return this.starting;
  }
  private async check(botId: string) { await this.open(); this.guard(); if (!await this.host.profiles.get(botId)) throw new Error('COMPANION_NOT_FOUND'); this.guard(); }
  async list(botId: string) { await this.check(botId); return this.engine.list(botId); }
  async save(botId: string,input: RoutineInput,id?: string,revision?: number) { await this.check(botId); return this.engine.put(botId,input,id,revision); }
  async createOnce(botId: string,input: RoutineInput,id: string) { await this.check(botId); return this.engine.createOnce(botId,input,id); }
  async runNow(botId: string,id: string,revision?: number) { await this.check(botId); return this.engine.runNow(botId,id,revision); }
  async remove(botId: string,id: string,revision?: number) { await this.check(botId); return this.engine.remove(botId,id,async () => {
    if (await this.scheduler.storage.get(`routine-${id}`)) await this.scheduler.engine.delete(`routine-${id}`,{ internalRoutine: true });
  },revision); }
  async lifecycle(botId: string,action: 'pause'|'resume'|'delete') {
    await this.open(); this.guard();
    if (action === 'resume') { await this.engine.setBotPaused(botId,false); return; }
    await this.engine.setBotPaused(botId,true);
    for (const routine of this.engine.list(botId)) {
      if (await this.scheduler.storage.get(`routine-${routine.id}`)) await this.scheduler.engine[action === 'delete' ? 'delete' : 'pause'](`routine-${routine.id}`,{internalRoutine:true});
    }
    if (action === 'delete') await this.engine.removeBot(botId);
  }
  private async execute(routine: Routine,run: RoutineRun,signal: AbortSignal,canDispatch: () => boolean) {
    this.guard(); signal.throwIfAborted();
    try { await this.host.assertMayRun(routine.botId); } catch (error) {
      if (error instanceof Error && error.message === 'COMPANION_CLOUD_NOT_READY') return {deferred:true};
      if (error instanceof Error && error.message === 'COMPANION_NOT_HOME') return {skipped:true};
      throw error;
    }
    const profile = await this.host.profiles.get(routine.botId);
    if (!profile || profile.status !== 'active') return {skipped:true};
    if (!canDispatch()) return {deferred:true};
    await this.host.ensureCanonical(profile); this.guard(); signal.throwIfAborted();
    const schedule = buildRoutineSchedule(routine,run,profile.sessionId);
    const existing = await this.scheduler.storage.get(schedule.id);
    if (existing) await this.scheduler.storage.update(schedule.id,{...schedule,createdAt:existing.createdAt});
    else await this.scheduler.storage.insert(schedule);
    this.guard(); signal.throwIfAborted();
    let cancellation: Promise<unknown> | undefined;
    const abort = () => { cancellation = this.scheduler.engine.pause(schedule.id,{internalRoutine:true}); void cancellation.catch(() => {}); };
    signal.addEventListener('abort',abort,{once:true});
    try {
      const result = await this.scheduler.engine.runNow(schedule.id,{deferToCaller:true,internalRoutine:true,canDispatch});
      this.guard();
      if (result.deferred) return {deferred:true};
      const completed = (await this.scheduler.storage.listRuns(schedule.id,10)).find(row => row.id === result.runId);
      if (!completed) throw new Error('ROUTINE_EXECUTION_MISSING');
      return {scheduleRunId:result.runId,skipped:completed.status === 'skipped',resultText:completed.resultText,
        ...(['success','skipped'].includes(completed.status) ? {} : {error:completed.errorMsg ?? 'ROUTINE_EXECUTION_FAILED'})};
    } finally { signal.removeEventListener('abort',abort); await cancellation; }
  }
  async close() { if (this.closed) return; this.closed=true; clearInterval(this.timer); await this.starting?.catch(() => {}); await this.engine.stop(); }
}
