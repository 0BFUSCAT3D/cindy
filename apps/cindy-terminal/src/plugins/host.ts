import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { NativePluginHost, type NativePluginHostOptions } from '@cindy/plugin-runtime';
import { GhostNetworkSlot, type NetworkSlotDeps } from '@cindy/plugin-runtime/networkSlot';
import { GhostFsSlot, type FsSlotDeps } from '@cindy/plugin-runtime/fsSlot';
import { GhostCardService, withCardToken, type GhostCardServiceDeps } from '@cindy/plugin-runtime/cardService';
import { sanitizeGhostCardHtml } from '@cindy/plugin-runtime/cardSanitizer';
import { createGhostKvStore } from '@cindy/plugin-runtime/ghostKvStore';
import { handleGhostKvRequest, readBoundedBodyText } from '@cindy/plugin-runtime/ghostKvEndpoint';
import { assertGhostInstallConsent, confirmedTaskCapability, type GhostInstallConsentDecision } from '@cindy/plugin-runtime/ghostInstallConsent';
import { evaluateGhostInstallConsent, ghostInstallConsentKey, ghostInstallConsentReceiverIdentity, type GhostInstallConsentFacts } from '@cindy/plugin-runtime/shared/ghostInstallConsent';
import { isValidPluginStoragePart, installedGhostStoragePart, installedGhostPhysicalRelId, findInstalledGhostForDeliveryTarget } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { ghostInstallApprovalToken, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import type { TerminalDurableSecrets } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import { TerminalPluginCredentials, type TerminalPluginCredentialOptions } from './credentials.js';

type Inspected = Exclude<Awaited<ReturnType<NativePluginHost['manager']['inspect']>>, {rejection:unknown}>;
type PendingInstall = {facts:GhostInstallConsentFacts;file:string; inspected:Inspected; decision:GhostInstallConsentDecision; controller:string; expiresAt:number};
export interface TerminalPluginOptions {
  root:string;
  runtimeDirectory:string;
  executablePath:NonNullable<NativePluginHostOptions['web']>['executablePath'];
  secrets:TerminalDurableSecrets;
  assertCurrent():void;
  locale():string;
  changed():void;
  onClose?():void;
  receive(instance:string,payload:unknown):Promise<unknown>;
  cards:Pick<GhostCardServiceDeps,'persist'|'broadcast'>;
  fs:Pick<FsSlotDeps,'getSessionSnapshot'|'requestWriteConfirm'|'writeSaveDeposit'>;
  network?:Omit<NetworkSlotDeps,'getGhost'|'captureRequestGuard'|'readSecret'>;
  credentials?:Partial<TerminalPluginCredentialOptions>;
  broker?:NativePluginHostOptions['broker'];
  log?:NativePluginHostOptions['manager']['log'];
}

/** Account-scoped product host. Consent pins the exact package and receiver;
 * the shared manager still owns approval journals, snapshots and atomic updates. */
export class TerminalPlugins {
  readonly native:NativePluginHost;
  readonly kv:ReturnType<typeof createGhostKvStore>;
  readonly network?:GhostNetworkSlot;
  readonly cards:GhostCardService;
  readonly fs:GhostFsSlot;
  readonly credentials:TerminalPluginCredentials;
  private readonly pending = new Map<string,PendingInstall>();
  private readonly removing=new Set<string>();
  private readonly cleanup = new Map<string,string[]>();
  private closed=false;
  private revision=0;
  private mutations:Promise<unknown>=Promise.resolve();
  readonly ready:Promise<void>;
  constructor(private readonly options:TerminalPluginOptions) {
    this.credentials=new TerminalPluginCredentials(this,{
      fetchImpl:fetch,openExternal:async()=>{throw new Error('PLUGIN_AUTHORIZATION_CONTROLLER_REQUIRED');},
      confirmAddHost:async()=>false,getLoginEmail:()=>null,...options.credentials,
    });
    this.kv=createGhostKvStore({getRootDir:()=>path.join(options.root,'plugin-kv'),log:options.log});
    const getGhost=(id:string)=>{this.guard();return this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id)??null;};
    this.cards=new GhostCardService({...options.cards,sanitize:sanitizeGhostCardHtml,
      hasCardSlot:id=>{const ghost=getGhost(id);return !!ghost?.enabled&&ghost.approval?.state==='approved'&&ghost.manifest.card!==undefined;},
      log:{debug:(message,meta)=>options.log?.info(message,meta),warn:(message,meta)=>options.log?.warn(message,meta)},
    });
    this.fs=new GhostFsSlot({...options.fs,getGhost,dataRootDir:()=>path.join(options.root,'plugin-fs'),
      callInfo:id=>this.cards.callInfoOf(id),inFlightCallInfo:id=>this.cards.inFlightCallInfoOf(id),log:options.log});
    if(options.network)this.network=new GhostNetworkSlot({...options.network,
      oauthTokens:this.credentials.oauth,
      connections:{hostsFor:id=>this.credentials.hostsFor(id),tokenFor:(id,host)=>this.credentials.tokenFor(id,host)},
      getGhost,inFlightCallInfo:id=>this.cards.inFlightCallInfoOf(id),
      readSecret:(id,key)=>this.readSecret(id,key),
      captureRequestGuard:id=>{
        this.guard();const previous=this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id);
        const approval=ghostInstallApprovalToken(previous?.approval);
        return ()=>{this.guard();const current=this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id);if(!current?.enabled||current.approval?.state!=='approved'||current.dir!==previous?.dir||ghostInstallApprovalToken(current.approval)!==approval)throw new Error('PLUGIN_CHANGED');};
      }});
    this.native=new NativePluginHost({
      manager:{getRootDir:()=>path.join(options.root,'plugins'),getStateDir:()=>path.join(options.root,'plugin-approvals'),
        getOwnerContextKey:()=>{this.guard();return options.root;},getLocale:options.locale,log:options.log,
        onChanged:()=>{this.revision++;options.changed();}},
      node:{nodePath:process.execPath,workerPath:path.join(options.runtimeDirectory,'plugin-node-worker.cjs'),snapshotWorkerPath:path.join(options.runtimeDirectory,'plugin-snapshot-worker.cjs')},
      broker:{...options.broker,log:options.log,ownerScope:{capture:()=>{this.guard();return this;},isCurrent:value=>value===this&&this.current(),isStable:()=>this.current()},
        resolveOauthSecret:(id,key,account)=>this.credentials.resolveOauthSecret(id,key,account),
        readSecret:(id,key)=>this.readSecret(id,key),secretSaved:async(id,key)=>(await this.readSecret(id,key))!==null},
      web:{executablePath:options.executablePath,mailRuntimeSource:()=>readFile(path.join(options.runtimeDirectory,'plugin-mail-runtime.js'),'utf8'),
        receive:async(id,payload)=>{
          this.guard();const type=(payload as {type?:unknown}|null)?.type;
          if(type==='fetch-request'&&this.network)return this.network.handleFetchRequest(id,payload);
          if(type==='fs-request')return this.fs.handleFsRequest(id,payload);
          if(type==='card-update'){this.cards.handleCardUpdate(id,payload);return {ok:true};}
          return options.receive(id,payload);
        },
        request:async(id,request,current)=>{
          if(new URL(request.url).pathname!=='/kv')return this.credentials.request(id,request,()=>this.current()&&current());
          const outcome=await handleGhostKvRequest({method:request.method,readBodyText:()=>readBoundedBodyText(request),store:this.kv,ghostId:id,isCurrent:()=>this.current()&&current(),log:options.log});
          return new Response(outcome.body??null,{status:outcome.status,headers:{'Content-Type':'application/json'}});
        }},
    });
    this.ready=this.open();
  }
  private async open() {
    for(const directory of ['plugins','plugin-approvals','plugin-kv','plugin-fs'])await privateDirectory(path.join(this.options.root,directory));
    this.guard();await this.native.open();this.guard();
    const pending=await readPrivateFile(path.join(this.options.root,'plugin-cleanup.json'));this.guard();
    if(pending){
      const rows:unknown=JSON.parse(pending.toString());
      if(!Array.isArray(rows)||rows.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!isValidPluginStoragePart(row[0])||!Array.isArray(row[1])||row[1].some((key:unknown)=>typeof key!=='string'||key.length>512)))throw new Error('PLUGIN_CLEANUP_INVALID');
      for(const [id,keys] of rows)this.cleanup.set(id,keys);
      // A crash before package removal must not erase a still-installed plugin.
      for(const ghost of this.native.list())this.cleanup.delete(installedGhostStoragePart(ghost));
      await this.persistCleanup();
      await this.retryCleanup().catch(()=>optionsCleanupPending(this.options));
    }
    for(const ghost of this.native.list())this.credentials.reconcile(installedGhostStoragePart(ghost),ghost.manifest);
  }
  private current(){try{this.guard();return true;}catch{return false;}}
  private guard(){if(this.closed)throw new Error('PLUGIN_HOST_CLOSED');this.options.assertCurrent();}
  version(){return String(this.revision);}
  installed(id:string){this.guard();return this.native.list().find(ghost=>installedGhostStoragePart(ghost)===id)??null;}
  credentialsChanged(){this.guard();this.revision++;this.options.changed();}
  withCredentialMutation<T>(id:string,action:()=>Promise<T>|T):Promise<T>{
    return this.mutate(async()=>{if(this.removing.has(id)||!this.installed(id))throw new Error('PLUGIN_CHANGED');return action();});
  }
  async list(){await this.ready;this.guard();await this.native.refresh();this.guard();return this.native.list();}
  async get(id:string){const ghost=(await this.list()).find(item=>installedGhostStoragePart(item)===id);if(!ghost)throw new Error('PLUGIN_NOT_FOUND');return ghost;}
  async callTool(id:string,request:{tool:string;args:Record<string,unknown>;signal?:AbortSignal;agentToolUseId?:string},context:{sessionId:string;sessionInstanceId:string;remoteHostId:string|null;assertCurrent():void}){
    await this.get(id);context.assertCurrent();this.guard();
    const callId=randomUUID();
    this.cards.registerCall(callId,{ghostId:id,sessionId:context.sessionId,sessionInstanceId:context.sessionInstanceId,remoteHostId:context.remoteHostId,toolUseId:request.agentToolUseId??null});
    try {
      const result=await this.native.dispatcher!.callGhostTool({ghostId:id,tool:request.tool,args:request.args,signal:request.signal,callId,sessionId:context.sessionId});
      context.assertCurrent();this.guard();
      return withCardToken(result,this.cards.hasCard(callId),callId);
    }finally{this.cards.finalizeCall(callId);}
  }
  private key(id:string,key:string){return `plugin:${id}:${key}`;}
  private async readSecret(id:string,key:string){
    return this.readSecretSync(id,key);
  }
  readSecretSync(id:string,key:string){this.guard();return this.options.secrets.getSync(this.key(id,key));}
  secretTailSync(id:string,key:string){
    this.guard();const tailKey=`plugin-tail:${id}:${key}`;
    const tail=this.options.secrets.getSync(tailKey);if(tail!==null)return tail;
    const value=this.readSecretSync(id,key);if(!value||value.length<4)return null;
    const migrated=value.slice(-4);this.options.secrets.setSync(tailKey,migrated);return migrated;
  }
  async saveSecret(id:string,key:string,value:string,expectedApproval?:string,assertCurrent:()=>void=()=>{}){
    if(typeof value!=='string'||value.length>64*1024)throw new Error('PLUGIN_SECRET_INVALID');
    await this.mutate(async()=>{
      const ghost=await this.get(id);
      assertCurrent();
      if(expectedApproval!==undefined&&ghostInstallApprovalToken(ghost.approval)!==expectedApproval)throw new Error('PLUGIN_CHANGED');
      const declared=ghost.manifest.node?.secretBindings?.some(binding=>binding.key===key&&!binding.oauthSecret)||ghost.manifest.network?.secrets?.some(secret=>secret.key===key&&['user','gh-cli'].includes(secret.source??'user'));
      if(!declared)throw new Error('PLUGIN_SECRET_NOT_DECLARED');
      this.guard();
      await this.writeSecret(id,key,value);
    });
  }
  async prepareInstall(file:string,controller:string) {
    await this.ready;this.guard();
    if(!path.isAbsolute(file))throw new Error('PLUGIN_PACKAGE_PATH_REQUIRED');
    for(const [id,pending] of this.pending)if(pending.expiresAt<Date.now())this.pending.delete(id);
    if(this.pending.size>=32)throw new Error('PLUGIN_CONFIRMATION_LIMIT');
    const inspected=await this.native.manager.inspect(file);this.guard();
    if('rejection' in inspected)throw new Error('PLUGIN_PACKAGE_REJECTED',{cause:inspected.rejection});
    const installed=findInstalledGhostForDeliveryTarget(await this.list(),{ghostId:inspected.manifest.id,namespace:null});
    const facts=evaluateGhostInstallConsent(installed,inspected.manifest,true)!;
    const decision:GhostInstallConsentDecision={mode:'confirmed',forced:true,key:ghostInstallConsentKey(facts,inspected.packageSha256,ghostInstallConsentReceiverIdentity(installed))};
    const id=randomUUID();const pending={facts,file,inspected,decision,controller,expiresAt:Date.now()+15*60_000};
    this.pending.set(id,pending);
    return {id,facts,packageSha256:inspected.packageSha256,expiresAt:pending.expiresAt};
  }
  pendingFor(controller:string){this.guard();return [...this.pending].filter(([,p])=>p.controller===controller&&p.expiresAt>=Date.now()).map(([id,p])=>({id,facts:p.facts}));}
  pendingInstall(id:string,controller:string){
    this.guard();const pending=this.pending.get(id);
    if(!pending||pending.controller!==controller||pending.expiresAt<Date.now())throw new Error('PLUGIN_CONFIRMATION_EXPIRED');
    return pending;
  }
  async confirmInstall(id:string,controller:string,assertCurrent:()=>void=()=>{}) {
    const pending=this.pendingInstall(id,controller);this.pending.delete(id);
    return this.mutate(async()=>{
      const {inspected,decision}=pending;
      await this.retryCleanup();
      const installed=findInstalledGhostForDeliveryTarget(await this.native.manager.listAsync(),{ghostId:inspected.manifest.id,namespace:null});
      const check=()=>{this.guard();assertCurrent();assertGhostInstallConsent(decision,findInstalledGhostForDeliveryTarget(this.native.manager.list(),{ghostId:inspected.manifest.id,namespace:null}),inspected.manifest,inspected.packageSha256);};
      check();
      const approvals={taskCapabilityApproved:confirmedTaskCapability(decision,installed,inspected.manifest),targetCapabilityApproved:confirmedTaskCapability(decision,installed,inspected.manifest,'targets')};
      if(installed){const instance=installedGhostStoragePart(installed);this.native.runtime?.stop(instance);await this.native.node.stopAndWait(instance);check();}
      const result=installed
        // The manager pins the previous receipt and package hash under its
        // mutation lock. This callback runs after swapping directories, when
        // reading the installed list no longer describes the old receiver.
        ? await this.native.manager.update(pending.file,{...approvals,namespace:null,expectedPackageSha256:inspected.packageSha256,expectedInstalledApproval:ghostInstallApprovalToken(installed.approval),beforePackageCommit:()=>{this.guard();assertCurrent();return this.credentials.prepareUpdate(installedGhostStoragePart(installed),installed.manifest,inspected.canonicalManifest);}})
        : await this.native.manager.install(pending.file,{...approvals,namespace:null,expectedPackageSha256:inspected.packageSha256,beforePackagePlacement:check});
      if('rejection' in result)throw new Error('PLUGIN_INSTALL_REJECTED',{cause:result.rejection});
      await this.native.refresh();return result.ghost;
    });
  }
  cancelInstall(id:string,controller:string){this.pendingInstall(id,controller);this.pending.delete(id);}
  async setEnabled(id:string,enabled:boolean) {
    return this.mutate(async()=>{const ghost=await this.get(id);const result=await this.native.manager.setEnabled(installedGhostPhysicalRelId(ghost),enabled,ghostInstallApprovalToken(ghost.approval),()=>this.guard());if('rejection' in result)throw new Error('PLUGIN_CHANGE_REJECTED');await this.native.refresh();});
  }
  private secretIndex(id:string){return `plugin-key-index:${id}`;}
  private storedSecretKeys(id:string):string[] {
    this.guard();const raw=this.options.secrets.getSync(this.secretIndex(id));
    if(!raw)return [];
    const keys:unknown=JSON.parse(raw);
    if(!Array.isArray(keys)||keys.some(key=>typeof key!=='string'||key.length>512))throw new Error('PLUGIN_SECRET_INDEX_INVALID');
    return keys;
  }
  /** Host-owned credential adapters also use this entry for derived OAuth keys. */
  async writeSecret(id:string,key:string,value:string|null):Promise<void>{
    this.writeSecretSync(id,key,value);
  }
  writeSecretSync(id:string,key:string,value:string|null){
    const current=()=>{this.guard();if(this.removing.has(id)||this.cleanup.has(id)||!this.native.list().some(ghost=>installedGhostStoragePart(ghost)===id))throw new Error('PLUGIN_CHANGED');};
    current();if(!isValidPluginStoragePart(id)||!key||key.length>512)throw new Error('PLUGIN_SECRET_INVALID');
    const keys=new Set(this.storedSecretKeys(id));
    if(value!==null){
      keys.add(key);this.options.secrets.setSync(this.secretIndex(id),JSON.stringify([...keys]));current();
      this.options.secrets.setSync(this.key(id,key),value);
      if(value.length>=4)this.options.secrets.setSync(`plugin-tail:${id}:${key}`,value.slice(-4));
      else this.options.secrets.deleteSync(`plugin-tail:${id}:${key}`);
    }else{
      this.options.secrets.deleteSync(this.key(id,key));this.guard();keys.delete(key);
      this.options.secrets.deleteSync(`plugin-tail:${id}:${key}`);
      this.options.secrets.setSync(this.secretIndex(id),JSON.stringify([...keys]));
    }
    this.guard();
  }
  private persistCleanup(){return atomicPrivateWrite(path.join(this.options.root,'plugin-cleanup.json'),JSON.stringify([...this.cleanup]));}
  private async retryCleanup(){
    for(const [id,keys] of this.cleanup){
      this.guard();
      if(!this.native.list().some(ghost=>installedGhostStoragePart(ghost)===id)){
        const removed=await Promise.allSettled([Promise.resolve().then(()=>this.kv.remove(id)),rm(path.join(this.options.root,'plugin-fs',id),{recursive:true,force:true}),...keys.flatMap(key=>[this.options.secrets.delete(this.key(id,key)),this.options.secrets.delete(`plugin-tail:${id}:${key}`)])]);
        if(removed.some(result=>result.status==='rejected'))throw new Error('PLUGIN_REMOVE_CLEANUP_FAILED');
        this.guard();await this.options.secrets.delete(this.secretIndex(id));this.guard();
      }
      this.cleanup.delete(id);
      try{await this.persistCleanup();}catch(error){this.cleanup.set(id,keys);throw error;}
    }
  }
  async uninstall(id:string) {
    return this.mutate(async()=>{
      const ghost=await this.get(id);this.removing.add(id);
      this.credentials.oauth.invalidateGhost(id);
      try{
      this.native.runtime?.stop(id);await this.native.node.stopAndWait(id);this.guard();
      const keys=new Set([...this.storedSecretKeys(id),...(ghost.manifest.node?.secretBindings??[]).map(binding=>binding.key),...(ghost.manifest.network?.secrets??[]).map(secret=>secret.key)]);
      this.cleanup.set(id,[...keys]);await this.persistCleanup();this.guard();
      const result=await this.native.manager.uninstall(installedGhostPhysicalRelId(ghost));
      if('rejection' in result){this.cleanup.delete(id);await this.persistCleanup();throw new Error('PLUGIN_REMOVE_REJECTED');}
      await this.native.refresh();
      try{await this.retryCleanup();}catch{throw new Error('PLUGIN_REMOVE_CLEANUP_FAILED');}
      }finally{this.removing.delete(id);}
    });
  }
  private async mutate<T>(action:()=>Promise<T>):Promise<T> {
    await this.ready;const next=this.mutations.then(async()=>{this.guard();const value=await action();this.guard();this.revision++;this.options.changed();return value;});this.mutations=next.catch(()=>{});return next;
  }
  private closing?:Promise<void>;
  close(){
    if(this.closing)return this.closing;
    this.credentials.close();this.closed=true;this.options.onClose?.();this.pending.clear();
    return this.closing=(async()=>{await this.ready.catch(()=>{});await this.mutations;await this.native.close();await this.cards.flushWrites();})();
  }
}

function optionsCleanupPending(options:TerminalPluginOptions){options.log?.warn('Plugin removal cleanup remains pending');}
