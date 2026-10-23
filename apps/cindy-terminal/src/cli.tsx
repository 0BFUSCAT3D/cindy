#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { setDefaultModel, waitForTurn, unwrap } from './client-operations.js';
import { EngineManager, runNativeLogin, nativeLoginStatus, type EngineKind } from './engines/index.js';
import { profilePath, privateDirectory, VERSION } from './platform.js';
import { connectTerminal, reconnectingClient } from './transport.js';
import { TerminalService } from './service.js';
import { TerminalServiceManager } from './service-manager.js';
import { runTui } from './ui/tui.js';
import { resolveLocale, getMessages } from './ui/i18n.js';
import type { TerminalClient } from './contracts.js';

let json = false;
let locale = resolveLocale();
function print(value: unknown) {
  process.stdout.write((json ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value,null,2))+'\n');
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE');
  const result=value as Record<string,unknown>;
  if (result.ok===false) throw new Error(String((result.error as Record<string,unknown>)?.code || 'OPERATION_FAILED'));
  return result.ok===true&&result.data&&typeof result.data==='object'?result.data as Record<string,unknown>:result;
}
async function stdin(limit = 1024 * 1024) {
  const chunks: Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){const data=Buffer.from(chunk);size+=data.length;if(size>limit)throw new Error('INPUT_TOO_LARGE');chunks.push(data);}
  return Buffer.concat(chunks).toString('utf8');
}
function required(value: string | undefined, code='ARGUMENT_REQUIRED'): string { if(!value)throw new Error(code);return value; }

async function startBackground(directory: string): Promise<TerminalClient> {
  try { return await connectTerminal(directory); } catch(error) {
    if(error instanceof Error&&!['SERVICE_NOT_RUNNING','SERVICE_CONNECT_TIMEOUT'].includes(error.message))throw error;
  }
  await privateDirectory(directory);
  const log=await fs.open(path.join(directory,'service.log'),'a',0o600);
  const child=spawn(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),'serve','--state-dir',directory],{
    detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true,env:process.env,
  });
  let failed=false;
  child.once('error',()=>{failed=true;});child.unref();await log.close();
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){
    if(failed)throw new Error('SERVICE_START_FAILED');
    await pause(100);
    try{return await connectTerminal(directory);}catch(error){if(error instanceof Error&&error.message==='SERVICE_ENDPOINT_INVALID')throw error;}
  }
  throw new Error('SERVICE_START_TIMEOUT');
}

async function main() {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed=parseArgs({allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},profile:{type:'string'},'state-dir':{type:'string'},
    lang:{type:'string'},device:{type:'string'},json:{type:'boolean'},once:{type:'boolean'},stdin:{type:'boolean'},
    wait:{type:'boolean'},detach:{type:'boolean'},model:{type:'string'},provider:{type:'string'},engine:{type:'string'},
    cwd:{type:'string'},timeout:{type:'string'},collection:{type:'string'},action:{type:'string'},'no-input':{type:'boolean'},sso:{type:'boolean'},all:{type:'boolean'},
    name:{type:'string'},url:{type:'string'},hostname:{type:'string'},user:{type:'string'},port:{type:'string'},'auth-method':{type:'string'},'key-file':{type:'string'},protocol:{type:'string'},'key-stdin':{type:'boolean'},
    'request-id':{type:'string'},allow:{type:'boolean'},deny:{type:'boolean'},'machine-key':{type:'boolean'},'passphrase-stdin':{type:'boolean'},
  }}); } catch { throw new Error('INVALID_COMMAND_ARGUMENTS'); }
  const values=parsed.values as Record<string,string|boolean|undefined>;
  const positionals=parsed.positionals;
  const str=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  json=values.json===true;locale=resolveLocale(str('lang'));
  let t=getMessages(locale);
  const directory=str('state-dir')?path.resolve(str('state-dir')!):profilePath(str('profile'));
  const [command,subcommand,...rest]=positionals;
  if(values.wait&&values.detach)throw new Error('CONFLICTING_WAIT_OPTIONS');
  const timeoutMs=str('timeout')===undefined?undefined:Number(str('timeout'))*1000;
  if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw new Error('INVALID_TIMEOUT');
  if(values.help||command==='help'){
    print(`Cindy ${VERSION}\n\n  cindy                         ${t.tasks}\n  cindy login [--sso]            ${t.login}\n  cindy auth status|accounts|logout|switch\n  cindy vault setup|unlock      --machine-key | --passphrase-stdin\n  cindy engines list|install|update|repair\n  cindy models [list|use]        ${t.models}\n  cindy providers [list|add|remove]\n  cindy devices [list|connect|disconnect]\n  cindy chat [message] --once [--detach]\n  cindy attach <id>              ${t.history}\n  cindy tasks list|get|history|stop|send|rename|archive|restore\n  cindy ssh list|connect|disconnect|add|edit|remove|terminal\n  cindy files list|read|write|stat|mkdir|remove|rename --cwd <path>\n  cindy resources [list|get|action]\n  cindy requests list|resolve\n  cindy config [get|set|reset]\n  cindy service start|status|stop|restart|install|uninstall|logs\n  cindy serve\n  cindy status\n\n  --profile <name>   --device <id>   --lang <locale>   --json\n  --model <id>   --provider <id>   --engine <pi|codex|claude-code>\n  --stdin   --no-input   --request-id <id>`);return;
  }
  if(values.version||command==='version'){print(VERSION);return;}
  if(command==='serve'){
    const service=new TerminalService(directory);
    try { await service.start(); } catch(error) { if(error instanceof Error&&error.message==='SERVICE_ALREADY_RUNNING')return;throw error; }
    const stop=()=>{void service.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    await service.stopped;return;
  }
  if(command==='service'&&subcommand==='logs'){
    const file=path.join(directory,'service.log');
    const handle=await fs.open(file,'r');
    try{const size=(await handle.stat()).size;const data=Buffer.alloc(Math.min(size,64*1024));await handle.read(data,0,data.length,Math.max(0,size-data.length));print(data.toString());}finally{await handle.close();}return;
  }
  if(command==='engines'||command==='providers'&&['login','logout','status'].includes(subcommand)){
    if(str('device'))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
    const manager=new EngineManager({profileDir:directory});
    if(command==='engines'&&(!subcommand||subcommand==='list')){print(await manager.allStatus());return;}
    const kind=required(str('engine')??rest[0],'ENGINE_REQUIRED') as EngineKind;
    if(!['claude-code','codex','pi'].includes(kind))throw new Error('INVALID_ENGINE');
    if(command==='engines'){
      if(!['install','update','repair'].includes(subcommand))throw new Error('UNKNOWN_COMMAND');
      print(subcommand==='update'?await manager.update(kind):subcommand==='repair'?await manager.repair(kind):await manager.install(kind));return;
    }
    const resolved=await manager.resolve(kind);if(!resolved)throw new Error('ENGINE_NOT_INSTALLED');
    if(subcommand==='status'){print({engine:kind,status:await nativeLoginStatus(kind,resolved.binary,str('provider'))});return;}
    if(json||values['no-input'])throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
    process.exitCode=await runNativeLogin(kind,resolved.binary,subcommand as 'login'|'logout',{onInstruction:instruction=>print(instruction==='pi-login'?'/login':'/logout')});return;
  }
  if(command&&!['status','service','auth','vault','config','devices','models','providers','tasks','requests','resources','files','ssh','chat','attach','login'].includes(command))throw new Error('UNKNOWN_COMMAND');
  const passive=command==='status'||command==='service'&&['status','stop','restart','uninstall'].includes(subcommand);
  let client:TerminalClient;
  try { client=passive?await connectTerminal(directory):await startBackground(directory); }
  catch(error){
    if(passive&&error instanceof Error&&error.message==='SERVICE_NOT_RUNNING'){
      if(subcommand==='restart')client=await startBackground(directory);
      else if(subcommand==='uninstall'){
        const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
        let result=await manager.uninstall();
        if(result.requiresLocalCompletion)result=await manager.completeUninstall();
        print(result);return;
      }else{print({running:false});return;}
    }else throw error;
  }
  const device=str('device');
  const call=(channel:string,args:unknown[]=[],remote=true)=>client.invoke(channel,args,remote?device:undefined);
  async function finishTurn(id:string,requestId:string,accepted:unknown,wait:boolean){
    const result=unwrap(accepted);
    if(!wait){print({sessionId:id,requestId,result});return;}
    const abort=new AbortController();const detach=()=>abort.abort();
    process.once('SIGINT',detach);process.once('SIGTERM',detach);
    try{
      const outcome=await waitForTurn(client,id,requestId,{device,timeoutMs,signal:abort.signal});
      const view={sessionId:id,requestId,status:outcome.status,finalText:outcome.finalText,errorCode:outcome.errorCode,pendingRequests:outcome.pendingRequests};
      print(json?view:outcome.status==='completed'?outcome.finalText??'':view);
      if(outcome.status==='waiting')process.exitCode=2;
      else if(outcome.status==='detached')process.exitCode=abort.signal.aborted?130:3;
      else if(outcome.status!=='completed')process.exitCode=1;
    }finally{process.removeListener('SIGINT',detach);process.removeListener('SIGTERM',detach);}
  }
  try{
    if(!str('lang')){
      const settings=object(await call('terminal:settings:get',[],false));
      const effective=object(settings.effective);
      if(typeof effective.language==='string'){locale=resolveLocale(effective.language);t=getMessages(locale);}
    }
    if(command==='status'||command==='service'&&subcommand==='status'){print(await call('terminal:status',[],false));return;}
    if(command==='service'){
      if(subcommand==='start'){print(await call('terminal:status',[],false));return;}
      if(['install','uninstall','stop'].includes(subcommand)){
        const result=object(await call(`terminal:service:${subcommand}`,[],false));
        if(result.requiresLocalCompletion){client.close();print(await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).completeUninstall());}
        else print(result);
        return;
      }
      if(subcommand==='restart'){
        await call('terminal:service:stop',[],false);client.close();
        for(let n=0;n<100;n++){try{await fs.access(path.join(directory,'service.json'));await pause(100);}catch{break;}}
        client=await startBackground(directory);print(await call('terminal:status',[],false));return;
      }
      throw new Error('UNKNOWN_COMMAND');
    }
    if(command==='auth'){
      if(subcommand==='status'||subcommand==='accounts'){const state=object(await call('terminal:auth:status',[],false));print(subcommand==='accounts'?state.accounts:state);}
      else if(subcommand==='logout')print(await call('terminal:auth:logout',[values.all===true],false));
      else if(subcommand==='switch')print(await call('terminal:auth:switch',[required(rest[0])],false));
      else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='vault'){
      if(subcommand==='setup'){
        if(values['machine-key'])print(await call('terminal:vault:initialize',['machine'],false));
        else if(values['passphrase-stdin'])print(await call('terminal:vault:initialize',['passphrase',(await stdin(16*1024)).replace(/\r?\n$/,'')],false));
        else throw new Error('VAULT_MODE_REQUIRED');
      }else if(subcommand==='unlock'&&values['passphrase-stdin'])print(await call('terminal:vault:unlock',[(await stdin(16*1024)).replace(/\r?\n$/,'')],false));
      else throw new Error('VAULT_MODE_REQUIRED');
      return;
    }
    if(command==='config'&&subcommand){
      if(device)throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
      if(subcommand==='get')print(await call('terminal:settings:get',[],false));
      else if(subcommand==='reset')print(await call('terminal:settings:reset',[rest],false));
      else if(subcommand==='set'){
        const key=required(rest[0]);const raw=required(rest[1]);
        const value=key==='remoteEnabled'?(raw==='true'?true:raw==='false'?false:undefined):raw;
        if(value===undefined)throw new Error('INVALID_SETTING');
        print(await call('terminal:settings:update',[{[key]:value}],false));
      }else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='devices'&&subcommand){
      if(subcommand==='list')print(await call('terminal:devices:list',[],false));
      else if(subcommand==='connect'||subcommand==='disconnect')print(await call(`terminal:devices:${subcommand}`,[required(rest[0])],false));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='models'&&subcommand){
      if(subcommand==='list')print(await call('maker:provider:list'));
      else if(subcommand==='use')print(await setDefaultModel(client,{model:required(rest[0]),providerId:required(str('provider')),agentKind:str('engine')??'pi'},device));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='providers'&&subcommand){
      if(subcommand==='list')print(await call('maker:provider:list'));
      else if(subcommand==='add'){
        const id=str('provider')??`custom-${randomUUID()}`;const engine=str('engine')??'pi';
        const key=values['key-stdin']?(await stdin(64*1024)).replace(/\r?\n$/,''):'';
        print(await call('maker:provider:custom:create',[{id,name:required(str('name')),auth:{method:key?'apiKey':'none'},runtimes:{[engine]:{baseUrl:required(str('url')),wireProtocol:str('protocol')??'openai-chat',models:[{id:required(str('model')),name:str('model')}]}}},{[engine]:key}]));
      }else if(subcommand==='remove')print(await call('maker:provider:custom:delete',[required(rest[0])]));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='tasks'){
      const id=()=>required(rest[0],'TASK_ID_REQUIRED');
      if(subcommand==='list')print(await call('local-db:sessions:list',[100,values.all?undefined:'active']));
      else if(subcommand==='get')print(await call('local-db:sessions:get',[id()]));
      else if(subcommand==='history')print(await call('local-db:messages:list',[id(),{limit:200}]));
      else if(subcommand==='stop')print(await call('maker:abort-session',[id()]));
      else if(subcommand==='send'){
        const requestId=str('request-id')??randomUUID();
        const result=await call('maker:send',[id(),{text:values.stdin?await stdin():required(rest.slice(1).join(' '),'MESSAGE_REQUIRED'),clientId:requestId}]);
        await finishTurn(id(),requestId,result,values.wait===true);
      }
      else if(subcommand==='rename')print(await call('local-db:sessions:update',[id(),{title:required(rest.slice(1).join(' '))}]));
      else if(subcommand==='archive'||subcommand==='restore')print(await call('local-db:sessions:update',[id(),{status:subcommand==='archive'?'archived':'active'}]));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='requests'){
      if(subcommand==='list')print(await call('maker:get-pending-interactions',[required(rest[0],'TASK_ID_REQUIRED')]));
      else if(subcommand==='resolve'){
        if(!values.stdin)throw new Error('DECISION_STDIN_REQUIRED');
        let decision:unknown;try{decision=JSON.parse(await stdin(64*1024));}catch{throw new Error('INVALID_DECISION');}
        print(await call('maker:resolve-interaction',[required(rest[0]),decision]));
      }else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='ssh'){
      if(device)throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
      const alias=()=>required(rest[0],'SSH_ALIAS_REQUIRED');
      if(subcommand==='list')print(await call('terminal:ssh:list',[],false));
      else if(['connect','disconnect','remove'].includes(subcommand))print(await call(`terminal:ssh:${subcommand}`,[alias()],false));
      else if(subcommand==='add'||subcommand==='edit'){
        const input={id:alias(),...(str('hostname')?{hostname:str('hostname')}:{}),...(str('user')?{user:str('user')}:{}),...(str('port')?{port:Number(str('port'))}:{}),...(str('auth-method')?{authMethod:str('auth-method')}:{}),...(str('key-file')?{identityFile:str('key-file')}:{})};
        print(await call(subcommand==='add'?'terminal:ssh:add':'terminal:ssh:update',subcommand==='add'?[input]:[alias(),input],false));
      }else if(subcommand==='terminal'){
        const host=alias();if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(host))throw new Error('INVALID_SSH_ALIAS');
        if(json||values['no-input']||!process.stdin.isTTY)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
        const child=spawn('ssh',[host],{stdio:'inherit',shell:false});
        process.exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',()=>reject(new Error('SSH_NOT_INSTALLED')));child.once('exit',code=>resolve(code??1));});
      }else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='files'){
      const workdir=required(str('cwd'),'WORKING_DIRECTORY_REQUIRED');
      const base={workdir:device?workdir:path.resolve(workdir),relPath:rest[0]??''};
      const fileCall=async(op:string,extra:Record<string,unknown>={})=>unwrap(await call('file-browser:remote-op',[{...base,...extra,op}]));
      if(subcommand==='list')print(await fileCall('listDir'));
      else if(subcommand==='read')print(await fileCall('readFile'));
      else if(subcommand==='stat')print(await fileCall('stat'));
      else if(subcommand==='write'){
        if(!values.stdin)throw new Error('FILE_CONTENT_STDIN_REQUIRED');
        print(await fileCall('writeFile',{content:await stdin()}));
      }else if(subcommand==='mkdir')print(await fileCall('createFolder'));
      else if(subcommand==='remove')print(await fileCall('deleteEntry'));
      else if(subcommand==='rename')print(await fileCall('renameEntry',{fromRel:required(rest[0]),toRel:required(rest[1])}));
      else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='resources'&&subcommand){
      const descriptor={protocolVersion:1,primitives:['text','actions','session-controls'],locale};
      const collectionId=str('collection')??rest[0];
      if(subcommand==='list')print(await call(collectionId?'maker:remote-resources:list':'maker:remote-resources:manifest',[{client:descriptor,...(collectionId?{collectionId,limit:100}:{})}]));
      else if(subcommand==='get'){
        const ref={collectionId:required(collectionId),kind:required(rest[1]),id:required(rest[2])};
        print(await call('maker:remote-resources:get',[{client:descriptor,ref}]));
      }else if(subcommand==='action'){
        let input:unknown={};if(values.stdin){try{input=JSON.parse(await stdin());}catch{throw new Error('INVALID_JSON_INPUT');}}
        const resourceRef=rest[1]?{collectionId:required(collectionId),kind:rest[1],id:required(rest[2])}:undefined;
        print(await call('maker:remote-resources:invoke',[{client:descriptor,collectionId:required(collectionId),actionId:required(str('action')),input,...(resourceRef?{resourceRef}:{})}]));
      }else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    const interactive=!json&&!values['no-input']&&!values.once&&process.stdin.isTTY&&process.stdout.isTTY;
    const uiCommand=!command||['login','models','providers','devices','config','attach','resources'].includes(command)||(command==='chat'&&!values.once);
    if(uiCommand){
      if(!interactive)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
      client=reconnectingClient(directory,client);
      const page=command==='login'?'login':command==='models'||command==='providers'?'models':command==='devices'?'connections':command==='config'?'service':command==='resources'?'resources':'tasks';
      let nextPage=page;
      for(;;){
        const external=await runTui(client,{locale,page:nextPage,task:command==='attach'?required(subcommand,'TASK_ID_REQUIRED'):undefined,device,sso:values.sso===true});
        if(!external)break;
        if(external.type==='service-uninstall'){
          print(await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).completeUninstall());return;
        }
        const manager=new EngineManager({profileDir:directory});const binary=await manager.resolve(external.kind);
        if(!binary)throw new Error('ENGINE_NOT_INSTALLED');
        await runNativeLogin(external.kind,binary.binary,external.operation,{onInstruction:value=>print(value==='pi-login'?'/login':'/logout')});
        client=reconnectingClient(directory,await startBackground(directory));
        await client.invoke('terminal:engines:refresh').catch(()=>{});nextPage='engines';
      }
      return;
    }
    if(command==='chat'&&values.once){
      const text=values.stdin?await stdin():positionals.slice(1).join(' ');
      if(!text.trim())throw new Error('MESSAGE_REQUIRED');
      const data=object(await call('maker:create-session',[{title:t.newTask,
        ...(str('cwd')?{workingDir:device?str('cwd'):path.resolve(str('cwd')!)}:{}),...(str('model')?{model:str('model')}:{}),
        ...(str('provider')?{providerId:str('provider')}:{}),...(str('engine')?{agentKind:str('engine')}:{}),
      }]));
      const id=data.sessionId??data.id;if(typeof id!=='string')throw new Error('INVALID_SESSION_RESPONSE');
      const requestId=str('request-id')??randomUUID();
      const result=await call('maker:send',[id,{text,clientId:requestId}]);
      await finishTurn(id,requestId,result,!values.detach);return;
    }
    throw new Error('UNKNOWN_COMMAND');
  }finally{client.close();}
}

void main().catch(error=>{
  const raw=error instanceof Error?String(('code' in error?error.code:undefined)??error.message):'';
  const code=/^[A-Za-z][A-Za-z0-9_]+$/.test(raw)?raw.toUpperCase():'OPERATION_FAILED';
  if(json)process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\n');
  else process.stderr.write(`${getMessages(locale).error} · ${code}\n`);
  process.exitCode=1;
});
