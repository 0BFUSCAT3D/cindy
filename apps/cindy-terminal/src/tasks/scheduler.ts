import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Scheduler, BUILTIN_TEMPLATES, applyTemplateParams, type Schedule, type ScheduleRun, type FireContext, type CreateScheduleInput, type UpdateScheduleInput, type ListFilter } from '@cindy/maker-scheduler';
import type { Logger } from '@cindy/maker-core';
import type { RemoteResourceRegistry, RemoteCollectionItem } from '@cindy/device-link';
import type { InvocationContext } from '../contracts.js';
import { privateDirectory } from '../platform.js';
import { TerminalScheduleStorage } from './schedule-storage.js';
import { preRun, runScript } from './schedule-process.js';
import type { TerminalCompanionHost } from '../remote/companions/host.js';
import type { TerminalTaskHost } from './host.js';
import { scheduleForm, scheduleFormInput, scheduleText } from './schedule-resources.js';
import { createScheduledWorkdirResolver } from '@cindy/worktree-core/scheduledWorkdir';
import type { TerminalWorktrees } from '../worktrees/host.js';
import type { WorktreeRuntimeLease } from '@cindy/worktree-core/runtimeLeases';

type ScheduledRunScope = { sessionId?: string; worktreeSessionId?: string; keepAlive?: boolean; worktreeLease?: WorktreeRuntimeLease | null };

export const TERMINAL_SCHEDULE_CHANNELS = ['list','get','create','update','delete','pause','resume','run-now','list-runs','delete-run','get-inflight-count','get-runtime-state','get-unread-count','mark-run-read','mark-all-runs-read','mark-schedule-runs-read','list-sidebar-index-runs','list-templates','create-from-template','script-capability-status'].map(action=>`maker:schedule:${action}`);
export interface TerminalSchedulerOptions {
  profileDir: string;
  tasks: TerminalTaskHost;
  worktrees?: TerminalWorktrees;
  companions?(): TerminalCompanionHost | undefined;
  logger: Logger;
  emit(channel: string, args: unknown[]): void;
  /** Host closure invalidated on owner switch, including while a script awaits. */
  canDispatch?(): boolean;
  notify?(schedule: Schedule, run: ScheduleRun): Promise<void>;
  scriptCall?(method: string, params: Record<string,unknown>, schedule: Schedule, ctx: FireContext): Promise<unknown>;
}
function object(value: unknown): Record<string,unknown> { if(!value || typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ARGUMENT');return value as Record<string,unknown>; }
function text(value: unknown): string {if(typeof value!=='string'||!value)throw new Error('INVALID_ARGUMENT');return value;}

/** One owner-scoped scheduler, using the shared engine for every trigger and run. */
export class TerminalSchedulerHost {
  readonly channels = TERMINAL_SCHEDULE_CHANNELS;
  readonly storage: TerminalScheduleStorage;
  readonly engine: Scheduler;
  readonly ready: Promise<void>;
  private closed=false;
  constructor(private readonly options: TerminalSchedulerOptions) {
    this.storage=new TerminalScheduleStorage(options.profileDir);
    this.engine=new Scheduler({storage:this.storage,runner:{fire:(schedule,ctx)=>this.fire(schedule,ctx)},generateId:randomUUID,maxConcurrentRuns:2,processId:process.pid,instanceId:randomUUID(),logger:{debug(){},info(){},warn:()=>options.logger.warn('SCHEDULER_WARNING'),error:()=>options.logger.error('SCHEDULER_ERROR')},validateTargetSession:async id=>{if(await options.companions?.()?.owns(id))return;const row=await options.tasks.storage.get(id);if(!row||row.deleted)throw new Error('SCHEDULE_TARGET_UNAVAILABLE');}});
    for(const name of ['fired','completed','failed','skipped','deferred','session-bound','changed','runtime-state','silenced','notified'] as const) this.engine.on(name as 'changed', (event)=>{
      if(this.closed)return;
      options.emit('maker:schedule:event',[event]);
      if(['completed','failed'].includes(event.type)&&!(event as {silenced?:boolean}).silenced)void this.notify(event as unknown as {scheduleId:string;runId:string});
    });
    options.tasks.configureScheduler({getScheduler:()=>{this.guard();return this.engine;}});
    this.ready=this.initialize();
  }
  private async initialize(){await privateDirectory(this.options.profileDir);await this.storage.open();if(!this.closed){await this.engine.start();this.options.emit('maker:schedule:event',[{type:'ready'}]);}}
  private guard(context?:InvocationContext){if(this.closed || this.options.canDispatch?.()===false)throw new Error('SCHEDULE_OWNER_CHANGED');if(context?.sharedTask)throw new Error('SHARED_TASK_PERMISSION_DENIED');context?.signal?.throwIfAborted();context?.assertCurrent?.();}
  private async notify(event:{scheduleId:string;runId:string}){
    const schedule=await this.storage.get(event.scheduleId);const run=(await this.storage.listRuns(event.scheduleId,Number.MAX_SAFE_INTEGER)).find(item=>item.id===event.runId);if(!schedule||!run||this.closed)return;
    if(this.options.notify)await this.options.notify(schedule,run).catch(()=>this.options.logger.warn('SCHEDULE_NOTIFICATION_FAILED'));
    else if(schedule.notify.desktop)this.options.emit('terminal:notification',[{id:run.id,title:schedule.name,text:run.resultText??run.errorMsg??run.status,sessionId:run.sessionId}]);
  }
  private validateInput(input:Record<string,unknown>){
    const notify=input.notify as Schedule['notify']|undefined;
    if((notify?.feishu || notify?.wecomGroup)&&!this.options.notify)throw new Error('SCHEDULE_NOTIFICATION_CONNECTION_REQUIRED');
    const script=input.scriptConfig as Schedule['scriptConfig'];
    if(script?.capabilities.some(capability=>capability!=='sessions.dispatch')&&!this.options.scriptCall)throw new Error('SCRIPT_CAPABILITY_CONNECTION_REQUIRED');
    if(input.useWorktree && !this.options.worktrees)throw new Error('SCHEDULE_WORKTREE_NOT_CONFIGURED');
  }
  private async fire(schedule:Schedule,ctx:FireContext){
    const holder: ScheduledRunScope = {};
    try { return await this.fireInner(schedule, ctx, holder); }
    finally {
      if (!holder.keepAlive && (!holder.sessionId || ctx.signal.aborted || !this.options.tasks.isTurnRunning(holder.sessionId))) {
        try {
          if (holder.sessionId) await this.options.tasks.invoke('maker:close-session', [holder.sessionId]);
          if (holder.worktreeLease) { await this.options.worktrees!.runtime.releaseWorktreeRuntimeLease(holder.worktreeLease); holder.worktreeLease = null; }
          if (holder.worktreeSessionId) await this.options.worktrees!.pool.releaseWorktree(holder.worktreeSessionId);
        } catch { this.options.logger.warn('SCHEDULE_WORKTREE_RELEASE_DEFERRED'); }
      } else if (holder.worktreeLease) {
        await this.options.worktrees!.runtime.releaseWorktreeRuntimeLease(holder.worktreeLease);
      }
    }
  }
  private async fireInner(schedule:Schedule,ctx:FireContext,holder:ScheduledRunScope){
    this.guard();ctx.signal.throwIfAborted();
    const companion=this.options.companions?.();
    if(schedule.targetSessionId&&companion&&await companion.owns(schedule.targetSessionId))return this.fireCompanion(companion,schedule,ctx);
    let sessionId=schedule.targetSessionId;
    let row=sessionId?await this.options.tasks.storage.get(sessionId):null;
    if(sessionId&&(!row||row.deleted)){if(!schedule.persistentSession)throw new Error('SCHEDULE_TARGET_UNAVAILABLE');sessionId=undefined;row=null;}
    if(row && this.options.tasks.isTurnRunning(row.id))return {sessionId:row.id,deferred:true,deferRetryMs:15_000};
    if(row?.archived)await this.options.tasks.invoke('local-db:sessions:patch-meta',[row.id,{status:'active'}]);
    const newSessionId = randomUUID();
    let cwd=row?.workDir??schedule.workingDir??path.join(this.options.profileDir,'scheduled-workspaces',ctx.runId);
    if (!row && schedule.useWorktree) {
      if (schedule.executionMode === 'script') throw new Error('SCRIPT_WORKTREE_UNSUPPORTED');
      const host = this.options.worktrees; if (!host) throw new Error('SCHEDULE_WORKTREE_NOT_CONFIGURED');
      const resolved = await createScheduledWorkdirResolver({ WorktreeManager: host.manager, WorktreePool: host.pool, resolveFreshSourceBranch: host.freshBase.resolveFreshSourceBranch })(schedule, newSessionId);
      if (!resolved.ok || !resolved.path) throw new Error('SCHEDULE_WORKTREE_CREATE_FAILED');
      holder.worktreeSessionId = resolved.worktreeSessionId;
      cwd = resolved.path;
      holder.worktreeLease = await host.runtime.acquireWorktreeRuntimeLease(newSessionId, cwd);
      await host.manager.awaitBackgroundCheckout(newSessionId);
      this.guard(); ctx.signal.throwIfAborted();
    }
    if(!row&&!schedule.workingDir)await privateDirectory(cwd);
    const hook=await preRun(schedule,ctx,cwd);this.guard();ctx.signal.throwIfAborted();
    if(hook){await ctx.onPreRunHookCompleted?.(hook);if(hook.decision==='skip')return {sessionId:sessionId??'',skipped:true,resultText:hook.stdout};if(hook.decision!=='run')throw new Error('PRE_RUN_HOOK_FAILED');}
    if(schedule.executionMode==='script'){
      const result=await runScript(schedule,ctx,cwd,(method,params)=>this.scriptCall(schedule,ctx,method,params));
      if(result.sessionId&&!await this.options.tasks.storage.get(result.sessionId))result.sessionId='';
      if(result.sessionId)await ctx.onSessionBound?.(result.sessionId);return result;
    }
    if(!sessionId){
      holder.sessionId = newSessionId;
      const created=await this.options.tasks.invoke('maker:create-session',[{id:newSessionId,title:schedule.name,workingDir:cwd,agentKind:schedule.modelAgentKind??schedule.agentKind,...(schedule.providerId?{providerId:schedule.providerId}:{}),...(schedule.model?{model:schedule.model}:{}),...(schedule.agentDeviceId?{agentDeviceId:schedule.agentDeviceId}:{}),...(schedule.effort?{effort:schedule.effort}:{})}]) as {id:string};
      sessionId=created.id;if(schedule.persistentSession)await this.engine.update(schedule.id,{targetSessionId:sessionId});
      holder.keepAlive = schedule.persistentSession;
    }
    const id=sessionId;await ctx.onSessionBound?.(id);this.guard();ctx.signal.throwIfAborted();
    const abort=()=>{void this.options.tasks.invoke('maker:abort-session',[id]).catch(()=>{});};ctx.signal.addEventListener('abort',abort,{once:true});
    let active=false;const unobserve=this.options.tasks.observeTask(id,event=>{ctx.onProgress?.();if(!active&&event.type==='status'&&event.data&&typeof event.data==='object'&&(event.data as {isRunning?:boolean}).isRunning){active=true;ctx.onTurnActive?.(id);}});
    try {
      await this.options.tasks.submitScheduled(id,schedule.prompt,{scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,firedAt:ctx.firedAt,requestId:`schedule_${ctx.runId}`,assertCurrent:()=>{this.guard();ctx.signal.throwIfAborted();}});
      for(;;){
        const receipt=await this.options.tasks.invoke('terminal:tasks:wait',[id,`schedule_${ctx.runId}`,{timeoutMs:25_000}],{source:'local',signal:ctx.signal,assertCurrent:()=>this.guard()}) as {status:string;finalText?:string;error?:string};
        if(receipt.status==='completed')return {sessionId:id,resultText:receipt.finalText??''};
        if(receipt.status==='failed'||receipt.status==='interrupted')throw new Error(receipt.error??'SCHEDULE_TURN_FAILED');
      }
    } finally {unobserve();ctx.signal.removeEventListener('abort',abort);}
  }
  private async fireCompanion(host:TerminalCompanionHost,schedule:Schedule,ctx:FireContext){
    const profile=await host.profileForSession(schedule.targetSessionId!);
    await host.assertMayRun(profile.id);
    if(await host.isBusy(profile.id))return {sessionId:profile.sessionId,deferred:true,deferRetryMs:15_000};
    const current=()=>{this.guard();ctx.signal.throwIfAborted();if(ctx.canDispatch?.()===false)throw new Error('ROUTINE_CANCELLED');};
    current();
    const hook=await preRun(schedule,ctx,path.join(host.profiles.home(profile.id),'workspace'));
    current();await host.assertMayRun(profile.id);
    if(hook){await ctx.onPreRunHookCompleted?.(hook);if(hook.decision==='skip')return {sessionId:profile.sessionId,skipped:true,resultText:hook.stdout};if(hook.decision!=='run')throw new Error('PRE_RUN_HOOK_FAILED');}
    const abort=()=>{void host.stop(profile.id).catch(()=>{});};ctx.signal.addEventListener('abort',abort,{once:true});
    try{
      current();await ctx.onSessionBound?.(profile.sessionId);
      const sent=await host.submitScheduled(profile.id,schedule.prompt,{kind:'scheduler',scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,firedAt:ctx.firedAt},current);
      await ctx.onTurnActive?.(profile.sessionId);
      const resultText=await sent.completion;current();return {sessionId:profile.sessionId,resultText};
    }finally{ctx.signal.removeEventListener('abort',abort);}
  }
  private async scriptCall(schedule:Schedule,ctx:FireContext,method:string,params:Record<string,unknown>){
    this.guard();ctx.signal.throwIfAborted();
    const capabilities=schedule.scriptConfig?.capabilities??[];
    if(method==='host.capabilities')return {protocol:'cindy-script/1',capabilities};
    if(method==='sessions.dispatch'){
      if(!capabilities.includes('sessions.dispatch'))throw new Error('SCRIPT_CAPABILITY_DENIED');
      const target=params.target_session_id?text(params.target_session_id):schedule.targetSessionId;
      if(schedule.targetSessionId&&target!==schedule.targetSessionId)throw new Error('SCRIPT_TARGET_MISMATCH');
      const id=target??(await this.options.tasks.invoke('maker:create-session',[{title:typeof params.title==='string'?params.title:schedule.name,workingDir:schedule.workingDir,...(schedule.model?{model:schedule.model,providerId:schedule.providerId,agentKind:schedule.agentKind}:{})}]) as {id:string}).id;
      const receipt=await this.options.tasks.submitScheduled(id,text(params.message),{scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,assertCurrent:()=>{this.guard();ctx.signal.throwIfAborted();}});
      return {...receipt,sessionId:id};
    }
    if(this.options.scriptCall)return this.options.scriptCall(method,params,schedule,ctx);
    throw new Error('SCRIPT_CAPABILITY_UNAVAILABLE');
  }
  async invoke(channel:string,args:unknown[]=[],context:InvocationContext={source:'local'}):Promise<unknown>{
    await this.ready;this.guard(context);let result:unknown;const id=()=>text(args[0]);
    switch(channel){
      case 'maker:schedule:list':result=await this.engine.list(args[0] as ListFilter|undefined);break;
      case 'maker:schedule:get':result=await this.engine.get(id());break;
      case 'maker:schedule:create':{const input=object(args[0]);this.validateInput(input);result=await this.engine.create(input as unknown as CreateScheduleInput);break;}
      case 'maker:schedule:update':{const input=object(args[1]);this.validateInput(input);result=await this.engine.update(id(),input as UpdateScheduleInput);break;}
      case 'maker:schedule:delete':result=await this.engine.delete(id());break;
      case 'maker:schedule:pause':result=await this.engine.pause(id());break;
      case 'maker:schedule:resume':result=await this.engine.resume(id());break;
      case 'maker:schedule:run-now':result=await this.engine.runNow(id(),{canDispatch:()=>!this.closed&&this.options.canDispatch?.()!==false});break;
      case 'maker:schedule:list-runs':result=await this.engine.listRuns(id(),typeof args[1]==='number'?Math.max(1,Math.min(1000,args[1])):100);break;
      case 'maker:schedule:delete-run':result=await this.engine.deleteRun(id());break;
      case 'maker:schedule:get-inflight-count':result=this.engine.getRuntimeSnapshot().inFlightRuns.filter(run=>!args[0]||run.scheduleId===args[0]).length;break;
      case 'maker:schedule:get-runtime-state':result=this.engine.getRuntimeSnapshot();break;
      case 'maker:schedule:get-unread-count':result=(await this.storage.allRuns()).filter(run=>run.status!=='running'&&!run.readAt).length;break;
      case 'maker:schedule:mark-run-read':case 'maker:schedule:mark-all-runs-read':case 'maker:schedule:mark-schedule-runs-read':{for(const run of await this.storage.allRuns())if(run.status!=='running'&&(channel.endsWith('mark-all-runs-read')||channel.endsWith('mark-run-read')&&run.id===id()||channel.endsWith('mark-schedule-runs-read')&&run.scheduleId===id()))await this.storage.updateRun(run.id,{readAt:Date.now()});result={success:true};break;}
      case 'maker:schedule:list-sidebar-index-runs':result=(await this.storage.allRuns()).filter(run=>run.sessionId);break;
      case 'maker:schedule:list-templates':result=BUILTIN_TEMPLATES;break;
      case 'maker:schedule:create-from-template': {
        const body=object(args[0]);const template=BUILTIN_TEMPLATES.find(item=>item.id===text(body.templateId));if(!template)throw new Error('TEMPLATE_NOT_FOUND');
        const parameters=body.paramValues?object(body.paramValues):{};if(Object.values(parameters).some(value=>typeof value!=='string'))throw new Error('INVALID_TEMPLATE_PARAMETERS');
        const overrides=body.overrides?object(body.overrides):{};const input={name:template.name,kind:'cron',cronExpr:template.cronExpr,timezone:template.timezone,recurring:template.recurring??true,agentKind:template.agentKind??'claude-code',model:template.model,providerId:template.providerId,effort:template.effort,fastMode:template.fastMode,useWorktree:template.useWorktree??false,persistentSession:template.persistentSession,silentWhenIdle:template.silentWhenIdle,notify:template.notify??{desktop:true,feishu:false},...overrides,prompt:overrides.prompt??applyTemplateParams(template.prompt??'',parameters as Record<string,string>,template.parameters)};
        this.validateInput(input);result=await this.engine.create(input as CreateScheduleInput);break;
      }
      case 'maker:schedule:script-capability-status':result={statuses:[{capability:'sessions.dispatch',available:true}]};break;
      default:throw new Error(`UNSUPPORTED_CHANNEL:${channel}`);
    }
    this.guard(context);return result;
  }
  registerResources(registry:RemoteResourceRegistry){
    const item=(schedule:Schedule):RemoteCollectionItem=>({
      ref:{collectionId:'schedules',kind:'schedule',id:schedule.id},revision:String(schedule.updatedAt),
      display:{title:schedule.name,subtitle:schedule.intervalMs?`${schedule.intervalMs/1000}s`:schedule.cronExpr,
        status:{label:schedule.status==='active'?scheduleText('active'):scheduleText('paused'),tone:schedule.status==='active'?'positive':'neutral'}},
      links:schedule.targetSessionId?[{rel:'task',target:{kind:'session',sessionId:schedule.targetSessionId}}]:[],
      actions:[{id:'run-now',label:scheduleText('run')},{id:schedule.status==='active'?'pause':'resume',label:scheduleText(schedule.status==='active'?'pause':'resume')},scheduleForm(schedule),
        {id:'delete',label:scheduleText('delete'),tone:'destructive',confirmation:{title:scheduleText('deleteTitle'),confirmLabel:scheduleText('delete')}}],
    });
    registry.register({
      collection:{id:'schedules',resourceKind:'schedule',title:scheduleText('schedules'),placement:'sidebar',actions:[scheduleForm()]},
      list:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();const rows=await this.engine.list();
        const offset=request.cursor?Number(request.cursor):0;if(!Number.isInteger(offset)||offset<0)throw new Error('INVALID_CURSOR');
        const limit=Math.min(request.limit??100,100);return {collectionId:'schedules',revision:rows.map(row=>row.updatedAt).join(','),items:rows.slice(offset,offset+limit).map(item),...(offset+limit<rows.length?{nextCursor:String(offset+limit)}:{})};
      },
      get:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();const row=await this.engine.get(request.ref.id);if(!row)throw new Error('SCHEDULE_NOT_FOUND');
        return {...item(row),blocks:[{id:'prompt',primitive:'text',fallbackMarkdown:row.prompt},{id:'configuration',primitive:'text',fallbackMarkdown:[row.workingDir,row.model,row.timezone].filter(Boolean).join(' · ')},
          {id:'edit',primitive:'form',fallbackMarkdown:'',data:{actionId:'edit',values:{name:row.name,prompt:row.prompt,workingDir:row.workingDir,agentKind:row.agentKind,providerId:row.providerId??'',model:row.model??'',kind:row.intervalMs?'interval':'cron',cronExpr:row.cronExpr,intervalSeconds:row.intervalMs?String(row.intervalMs/1000):'',timezone:row.timezone,useWorktree:row.useWorktree,__revision:String(row.updatedAt)}}}]};
      },
      invoke:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();
        const invocation:InvocationContext={source:'local',assertCurrent:context.assertCurrent};
        if(request.actionId==='create'&&!request.resourceRef){
          const input=scheduleFormInput(request.input??{});this.validateInput(input as Record<string,unknown>);
          await this.invoke('maker:schedule:create',[input],invocation);
        }else{
          if(!request.resourceRef||request.resourceRef.kind!=='schedule'||request.resourceRef.collectionId!=='schedules')throw new Error('INVALID_ACTION');
          const row=await this.engine.get(request.resourceRef.id);if(!row)throw new Error('SCHEDULE_NOT_FOUND');context.assertCurrent?.();
          if(request.actionId==='edit'){
            if(request.input?.__revision!==undefined&&request.input.__revision!==String(row.updatedAt))throw new Error('SCHEDULE_REVISION_CHANGED');
            await this.invoke('maker:schedule:update',[row.id,scheduleFormInput(request.input??{},row)],invocation);
          }
          else if(['run-now','pause','resume','delete'].includes(request.actionId))await this.invoke(`maker:schedule:${request.actionId}`,[row.id],invocation);
          else throw new Error('INVALID_ACTION');
        }
        return {effects:[{kind:'refresh-collection',collectionId:'schedules'}]};
      },
    });
  }
  async close(){this.closed=true;this.options.tasks.configureScheduler(undefined);await this.ready;await this.engine.stop();await this.storage.flush();}
}
