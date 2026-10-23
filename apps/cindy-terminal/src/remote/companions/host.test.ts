import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAgent, type AgentEvent, type AgentSessionHandle, type Logger, type StartSessionOptions } from '@cindy/maker-core';
import { TerminalCompanionHost } from './host.js';
import { TerminalModelConfig } from '../../models/config.js';
import type { RuntimeInput } from '../../models/runtime.js';
import { RemoteResourceRegistry } from '@cindy/device-link';
import { registerCompanionResources } from './resources.js';
import { TerminalCompanionRoutines } from './routines.js';
import { TerminalSchedulerHost } from '../../tasks/scheduler.js';
import type { TerminalTaskHost } from '../../tasks/host.js';
const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child:()=>logger};
const roots:string[]=[];const hosts:TerminalCompanionHost[]=[];
const schedulers:TerminalSchedulerHost[]=[];
afterEach(async()=>{for(const host of hosts.splice(0)){await host.routines?.close();await host.close();}for(const scheduler of schedulers.splice(0))await scheduler.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(path.join(os.tmpdir(),'cindy-companion-'));roots.push(root);let active=true;const starts:StartSessionOptions[]=[];const sent:string[]=[];const configs:RuntimeInput[]=[];const vault=new Map<string,string>();const models=new TerminalModelConfig(root,{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);}},async()=>({authenticated:true}));await models.open();await models.saveProvider({id:'fixture',name:'Fixture',auth:{method:'none'},runtimes:{'claude-code':{baseUrl:'http://127.0.0.1:1',models:[{id:'test',name:'Test',contextWindow:200000}]}}},{},true);await models.setDefault({agentKind:'claude-code',providerId:'fixture',model:'test'});const create=async(input:RuntimeInput)=>{configs.push(input);const agent=new ClaudeCodeAgent({auth:{getState:async()=>({authenticated:true}),getAuthEnv:async()=>({}),triggerLogin:async()=>({authenticated:true}),logout:async()=>{}},runtimeConfig:{},logger,binaryPath:process.execPath});agent.startSession=async options=>{starts.push(options);const events:AgentEvent[]=[];let ended=false;let awaken:()=>void=()=>{};const handle:AgentSessionHandle={id:'native-'+options.sessionId,agentKind:'claude-code',model:options.model,async send(message){const text=typeof message.content==='string'?message.content:'';sent.push(text);events.push({type:'text',data:{text:'Reply: '+text,isFinal:true}},{type:'done',data:{}});awaken();},async steer(){},async abort(){},async close(){ended=true;awaken();},async *events(){while(!ended||events.length){const event=events.shift();if(event)yield event;else await new Promise<void>(resolve=>{awaken=resolve;});}},getUsageSnapshot:()=>({tokenUsage:0,contextTokens:0,contextWindow:200000,costUsd:0}),isTurnRunning:()=>false,setInteractionResolver() {}};return handle;};return agent;};const host=new TerminalCompanionHost({root:path.join(root,'companions'),profileDir:root,models,logger,guard:()=>{if(!active)throw new Error('OWNER_CHANGED');},emit(){},binary:async()=>process.execPath,createAgent:create});hosts.push(host);return {root,host,starts,sent,configs,revoke:()=>{active=false;}};}

/** Tier: integration. A companion must keep Profile identity/history and real
 * Bot-runtime/memory/MCP isolation while replacing only its native handle. */
it('keeps one independent Profile and journal, mounts memory and personal skills, and does not replay duplicate delivery',async()=>{
 const f=await setup();const profile=await f.host.create({name:'Cindy',templateId:'cindy'});const first=await f.host.send(profile.id,'hello','once');expect(await first.completion).toContain('hello');expect(f.starts[0].botRuntimeProfile?.botId).toBe(profile.id);expect(f.configs[0].tools?.providers.map(item=>item.name)).toContain('cindy_memory');expect(f.starts[0].botProfilePrompt).toContain('Cindy');
 const duplicate=await f.host.send(profile.id,'hello','once');expect(await duplicate.completion).toContain('hello');expect(f.sent).toHaveLength(1);
 await f.host.stop(profile.id);expect((await f.host.messages(profile.sessionId)).map(row=>row.role)).toEqual(['user','assistant']);const second=await f.host.send(profile.id,'again','twice');await second.completion;expect(f.starts[1].resumeSessionId).toBe('native-'+profile.sessionId);expect(f.starts[1].botRuntimeProfile?.botId).toBe(profile.id);
 const another=await f.host.create({name:'Other'});await f.host.profiles.writeMemory(profile.id,'fact.md','first profile only');expect(await f.host.profiles.readMemory(another.id,'fact.md')).toBeNull();await expect(f.host.profiles.change(profile.id,{models:[{agentKind:'invalid',model:'x',providerId:'x'} as never]})).rejects.toThrow('INVALID_MODEL_SELECTION');expect((await f.host.profiles.get(profile.id))?.models).toEqual([]);
 const registry=new RemoteResourceRegistry();registerCompanionResources(registry,f.host);const listed=await registry.list({controllerDeviceId:'owner'}, {client:{protocolVersion:1,primitives:[],locale:'ja'},collectionId:'teammates'});expect(listed.items[0].ref.kind).toBe('bot');expect(listed.items[0].display.status?.label).toMatchObject({translations:{ja:'準備完了',ko:'준비됨','zh-TW':'就緒'}});
 f.revoke();await expect(f.host.send(profile.id,'stale')).rejects.toThrow('OWNER_CHANGED');await f.host.close();
});

/** Tier: security. Model-authored files cannot traverse a Profile boundary through
 * a local symlink; deleting a Profile must not resurrect it at daemon restart. */
it('rejects a linked private shelf and preserves deletion across restart',async()=>{const f=await setup();const profile=await f.host.create({id:'x'.repeat(100),name:'A'});expect(profile.sessionId.length).toBeLessThan(100);const home=f.host.profiles.home(profile.id);await rm(path.join(home,'skills'),{recursive:true});await symlink(f.root,path.join(home,'skills'));await expect(f.host.profiles.writeSkill(profile.id,'escape','body')).rejects.toThrow('UNSAFE_PROFILE_DIRECTORY');await f.host.remove(profile.id);expect(await f.host.profiles.list()).toEqual([]);});

/** Tier: integration. Cloud transfer previously refused todos/workbench/routines.
 * A real companion turn through the shared scheduler must retain its source,
 * survive restart without replay, and suspend foreign-machine pre-run commands. */
it('runs a transferred routine in its companion and preserves portable owner data',async()=>{
  const f=await setup();const profile=await f.host.create({name:'Routine fixture'});
  const taskPort={configureScheduler(){},storage:{get:async()=>null}} as unknown as TerminalTaskHost;
  const scheduler=new TerminalSchedulerHost({profileDir:f.root,tasks:taskPort,companions:()=>f.host,logger,emit(){}});schedulers.push(scheduler);
  const routines=new TerminalCompanionRoutines(f.host,scheduler);f.host.routines=routines;await routines.open();
  const store=await f.host.todos(profile.id);
  const todo=await store.patch({key:'owner-request',origin:'assigned',title:'Read the report',outcome:'A checked report',next:null,sources:[]});
  await store.importItems([{...todo,title:'Transferred report'}],[]);
  expect((await store.read()).items[0].title).toBe('Transferred report');
  await f.host.workbench.mergeCompanionWorkbench(f.root,profile.id,'server',{directories:[{path:'C:\\Users\\test\\reports',deviceId:'desktop',addedAt:new Date(0).toISOString()}],tasks:{}});
  expect((await f.host.workbench.readCompanionWorkbench(f.root,profile.id,'server')).directories).toEqual([{path:'C:\\Users\\test\\reports',deviceId:'desktop',addedAt:new Date(0).toISOString()}]);
  const input={name:'Check',prompt:'Check the saved report',enabled:true,triggers:[{id:'hourly',kind:'interval' as const,intervalMs:3_600_000}]};
  await routines.transfer.importCompanionRoutines(profile.id,[{id:'portable-routine-001',input,originDeviceId:'desktop'},{id:'foreign-check-routine-001',input:{...input,preRunHook:{command:'desktop-only-command'}},originDeviceId:'desktop'}],[],'server');
  expect((await routines.list(profile.id)).find(row=>row.id==='foreign-check-routine-001')?.enabled).toBe(false);
  const registry=new RemoteResourceRegistry();routines.registerResources(registry);
  const client={protocolVersion:1,primitives:['text','actions'],locale:'en'};
  await registry.invoke({controllerDeviceId:'owner'},{client,collectionId:'routines',resourceRef:{collectionId:'routines',kind:'routine',id:'portable-routine-001'},actionId:'run'});
  await expect.poll(()=>routines.engine.history('portable-routine-001')[0]?.status,{interval:10,timeout:2000}).toBe('success');
  expect(f.sent).toHaveLength(1);expect(f.sent[0]).toContain('Check the saved report');
  const history=await f.host.storage.history(profile.sessionId);
  expect(history.records.find(row=>row.kind==='user')?.agentMeta).toMatchObject({origin:{kind:'scheduler',scheduleId:'routine-portable-routine-001'}});
  expect(f.configs[0].tools?.providers.map(row=>row.name)).toContain('cindy_helper');
  await f.host.change(profile.id,{status:'paused'});
  expect(routines.engine.list(profile.id).find(row=>row.id==='portable-routine-001')?.enabled).toBe(true);
  await routines.close();const restored=new TerminalCompanionRoutines(f.host,scheduler);f.host.routines=restored;await restored.open();
  expect(restored.engine.history('portable-routine-001')[0]?.status).toBe('success');
  await restored.engine.tick();expect(f.sent).toHaveLength(1);
  expect((await restored.transfer.listCompanionRoutines(profile.id,'server')).map(row=>row.id).sort()).toEqual(['foreign-check-routine-001','portable-routine-001']);
});
