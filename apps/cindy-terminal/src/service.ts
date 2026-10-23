import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import wrtc from '@roamhq/wrtc';
import { TerminalAuthController, type AuthRegion, type TerminalAuthSnapshot } from '@cindy/auth-client';
import { createNodeDirectRtcRuntime, FILE_PEER_CHANNEL, REMOTE_AGENT_CHANNEL, PROVIDER_GROUP_REMOTE_CHANNEL, providerShareHostPeer, parseProviderSharePeer } from '@cindy/device-link';
import type { Logger } from '@cindy/maker-core';
import globalEndpoints from '../../../config/endpoint.global.json';
import chinaEndpoints from '../../../config/endpoint.json';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer } from './transport.js';
import { TerminalTaskHost, TerminalSchedulerHost } from './tasks/index.js';
import { TerminalDeviceService, TerminalFilePeerService } from './remote/index.js';
import { TerminalFileBrowser } from './file-browser.js';
import { TerminalResources } from './resources.js';
import { SettingsStore } from './settings.js';
import { TerminalServiceManager } from './service-manager.js';
import { VERSION } from './platform.js';
import { EngineManager } from './engines/manager.js';
import type { EngineKind } from './engines/types.js';
import { TerminalSshService } from './ssh.js';
import { TerminalRemoteAgentService } from './remote/agent.js';
import { TerminalRemoteAccountService } from './remote/account.js';
import { TerminalMembershipService } from './remote/membership.js';
import { TerminalProviderGroups } from './remote/groups.js';
import { TerminalGuestRoutes } from './remote/guest-routes.js';
import { TerminalRemoteModelGrants } from './remote/model-grants.js';
import { createGuestProviderRouteBinder, guestProviderModelIds, resolveGuestProviderId } from '@cindy/remote-agent/host/providerAccess';
import { registerRemoteManagementResources } from './remote/resources.js';
import { readDeviceProviderViews } from '@cindy/remote-agent';
import type { InvocationContext } from './contracts.js';

function valueString(value: unknown): string { if (typeof value !== 'string') throw new Error('INVALID_ARGUMENT'); return value; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT'); return value as Record<string,unknown>; }

/** Only explicitly classified runtime diagnostics leave the service. */
const logger: Logger = {
  trace() {}, debug() {}, info() {},
  warn() { process.stderr.write('[Cindy] RUNTIME_WARNING\n'); },
  error() { process.stderr.write('[Cindy] RUNTIME_ERROR\n'); },
  fatal() { process.stderr.write('[Cindy] RUNTIME_FATAL\n'); },
  child() { return logger; },
};

export class TerminalService {
  readonly settings: SettingsStore;
  readonly secrets: TerminalSecretStore;
  readonly transport: TerminalTransportServer;
  readonly manager: TerminalServiceManager;
  private auth!: TerminalAuthController;
  private remote!: TerminalDeviceService;
  private files!: TerminalFilePeerService;
  private browser!: TerminalFileBrowser;
  private resources!: TerminalResources;
  private tasks!: TerminalTaskHost;
  private scheduler!: TerminalSchedulerHost;
  private agents!: TerminalRemoteAgentService;
  private account!: TerminalRemoteAccountService;
  private membership!: TerminalMembershipService;
  private groups!: TerminalProviderGroups;
  private guestRoutes!: TerminalGuestRoutes;
  private modelGrants!: TerminalRemoteModelGrants;
  private ssh!: TerminalSshService;
  private readonly engines: EngineManager;
  private startedAt = Date.now();
  private ownerGeneration = 0;
  private ownerKey = 'guest';
  private ownerChange: Promise<void> = Promise.resolve();
  private ownerSuspended = false;
  private subscriptions = new Map<string, () => void>();
  private authorization: { url: string; expiresAt: number } | null = null;
  private init: Promise<void> = Promise.resolve();
  private refreshTimer?: NodeJS.Timeout;
  private stopWait: () => void = () => {};
  readonly stopped = new Promise<void>(resolve => { this.stopWait = resolve; });
  private closing?: Promise<void>;

  constructor(readonly profileDir: string, readonly region: AuthRegion = 'global') {
    this.settings = new SettingsStore(profileDir);
    this.secrets = new TerminalSecretStore(profileDir);
    this.engines = new EngineManager({ profileDir, onProgress: progress => this.transport?.publish('terminal:engines:progress', [progress]) });
    this.manager = new TerminalServiceManager(profileDir,path.resolve(process.argv[1]));
    this.transport = new TerminalTransportServer(profileDir, async (channel,args,deviceId) => {
      await this.init;
      if (deviceId) {
        if (channel.startsWith('terminal:')) throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
        return this.remote.invoke(deviceId,channel,args);
      }
      return this.invoke(channel,args,{source:'local'});
    });
  }

  async start(): Promise<void> {
    // Bind before opening mutable stores. A second process never reaches them.
    await this.transport.listen();
    this.init = this.initialize();
    try { await this.init; } catch (error) { await this.transport.close();throw error; }
  }
  private async initialize() {
    await this.settings.open(); await this.secrets.open();
    this.auth = new TerminalAuthController({
      deviceId:this.settings.deviceId, region:this.region, locale:this.settings.snapshot().effective.language, fetch,
      endpoints:{global:{baseUrl:globalEndpoints.authApiBaseUrl,hostedCallbackUrl:globalEndpoints.authDesktopCallbackUrl},cn:{baseUrl:chinaEndpoints.authApiBaseUrl,hostedCallbackUrl:chinaEndpoints.authDesktopCallbackUrl}},
      secretStore:{
        load:async()=>{const value=await this.secrets.get('cindy-auth');return value ? JSON.parse(value) : null;},
        save:vault=>this.secrets.set('cindy-auth',JSON.stringify(vault)),
      },
      onAuthorizeUrl:request=>{
        this.authorization={url:request.url,expiresAt:request.expiresAt};
        this.transport.publish('terminal:auth:url',[this.authorization]);
        request.signal.addEventListener('abort',()=>{if(this.authorization?.url===request.url)this.authorization=null;},{once:true});
      },
      beforeAccountChange:async()=>{
        this.ownerSuspended = true;
        this.ownerGeneration++;this.remote?.stop();
        this.files?.stop();this.browser?.stop();this.resources?.close();this.membership?.close();this.guestRoutes?.close();await this.modelGrants?.close();await this.agents?.stop();await this.groups?.close();await this.ssh?.close();
        // close() preserves history and native resume ids; no record is deleted.
        await this.scheduler?.close();
        if(this.tasks)await this.tasks.close();
      },
      onChange:snapshot=>{
        if(snapshot.flow?.step!=='browser-redirect')this.authorization=null;
        this.transport.publish('terminal:auth:changed',[snapshot]);
        this.ownerChange=this.ownerChange.catch(()=>{}).then(()=>this.syncOwner(this.auth.snapshot()));
        void this.ownerChange.catch(()=>logger.error('OWNER_SWITCH_FAILED'));
      },
    });
    this.remote = new TerminalDeviceService({
      getToken:async()=>this.auth.getAccessToken(),
      getHello:()=>({deviceName:this.settings.snapshot().effective.deviceName,platform:process.platform,appVersion:VERSION,remoteControlEnabled:this.settings.snapshot().effective.remoteEnabled,busy:this.tasks?.isBusy() ?? false}),
      getWsUrl:()=>{
        const endpoints=(this.auth.snapshot().session?.realm ?? this.region)==='cn'?chinaEndpoints:globalEndpoints;
        const url=new URL('/api/device-link/ws',endpoints.deviceLinkApiBaseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';return url.href;
      },
      getOwnerScope:()=>this.auth.snapshot().session ? `${this.ownerKey}:${this.ownerGeneration}` : null,
      createWebSocket:(url,headers)=>new WebSocket(url,{headers}),
      directRuntime:createNodeDirectRtcRuntime(wrtc),
      resolveScopedAuthority: source => this.membership.resolve(source),
      invokeLocal:async(channel,args,context)=>{
        context.assertCurrent();
        if(channel===REMOTE_AGENT_CHANNEL)return this.agents.request(args[0],context);
        if(channel===PROVIDER_GROUP_REMOTE_CHANNEL)return this.groups.request(args[0],context);
        if(channel==='maker:provider:list'){
          const providers=this.membership.projectProviders(context.source,await this.agents.views());
          return context.source.kind==='owner'?this.groups.decorate(providers):{providers};
        }
        if(channel===FILE_PEER_CHANNEL){if(context.source.kind!=='owner')throw new Error('OWNER_REQUIRED');return this.files.request(args[0],context);}
        if(context.source.kind==='provider-share'){
          const providers=this.membership.projectProviders(context.source,await this.agents.views());
          const kinds=[...new Set(providers.flatMap(provider=>provider.agents))];
          if(channel==='maker:list-available-agents')return kinds;
          if(!kinds.includes(args[0] as never))throw new Error('REMOTE_AGENT_UNAVAILABLE');
        }
        const ownerId=this.ownerKey;
        return this.invoke(channel,args,{source:'remote',deviceId:context.sourceDeviceId,ownerId,sharedTask:this.membership.taskContext(context.source),signal:context.signal,assertCurrent:()=>{
          context.assertCurrent();
          if(this.ownerKey!==ownerId || this.ownerSuspended)throw new Error('OWNER_CHANGED');
        }});
      },
      onPush:push=>this.transport.publish('terminal:remote-event',[push]),
      logger:{debug(){},info(){},warn(){logger.warn('DEVICE_LINK_WARNING');},error(){logger.error('DEVICE_LINK_ERROR');}},
    });
    this.files=new TerminalFilePeerService({
      native:wrtc,
      getOwnerScope:()=>this.auth.snapshot().session?.status==='authenticated'?`${this.ownerKey}:${this.ownerGeneration}`:null,
      openFile:(url,context)=>this.browser.openMedia(url,context),
      invokeAuthorized:(channel,args,context)=>this.remote.dispatchLocal(channel,args,context),
      invokeRemote:(peer,channel,args)=>this.remote.invoke(peer,channel,args),
    });
    await this.createTasks('guest');
    if(!this.secrets.status().locked)await this.auth.initialize();
    await this.ownerChange;
    this.refreshTimer=setInterval(()=>{
      const flow=this.auth.snapshot().flow;
      if(!this.secrets.status().locked && (!flow || flow.step==='completed'))void this.auth.refresh().catch(()=>logger.warn('AUTH_REFRESH_FAILED'));
    },5*60_000);
    this.refreshTimer.unref();
  }

  private async syncOwner(snapshot: TerminalAuthSnapshot) {
    if(this.closing)return;
    const next=snapshot.session?.key ?? 'guest';
    if(next!==this.ownerKey || this.ownerSuspended){
      await this.scheduler?.close();
      this.remote.stop();this.files.stop();this.browser.stop();this.resources.close();this.membership.close();this.guestRoutes.close();await this.modelGrants.close();await this.agents.stop();await this.groups.close();await this.ssh.close();await this.tasks.close();
      for(const dispose of this.subscriptions.values())dispose();
      this.subscriptions.clear();
      await this.createTasks(next);this.ownerSuspended=false;
    }
    if(snapshot.session?.status==='authenticated')this.remote.start();
    else this.remote.stop();
  }
  private async createTasks(owner: string) {
    this.ownerKey=owner;
    const generation=this.ownerGeneration;
    const ownerDir=path.join(this.profileDir,'owners',createHash('sha256').update(owner).digest('hex').slice(0,32));
    const scope=()=>`${this.ownerKey}:${this.ownerGeneration}`;
    this.guestRoutes=new TerminalGuestRoutes(scope);
    this.modelGrants=new TerminalRemoteModelGrants(ownerDir,scope);
    try { await this.modelGrants.open(); } catch { logger.warn('REMOTE_MODEL_GRANTS_UNAVAILABLE'); }
    this.browser=new TerminalFileBrowser(this.profileDir,(channel,value)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      this.transport.publish(channel,[value]);void this.remote.publish(channel,value).catch(()=>{});
    });
    this.tasks=new TerminalTaskHost({profileDir:ownerDir,logger,remoteInvoke:(deviceId,channel,args)=>this.invokeRemoteResult(deviceId,channel,args),secretStore:{
      get:key=>this.secrets.get(`${owner}:${key}`),set:(key,value)=>this.secrets.set(`${owner}:${key}`,value),delete:key=>this.secrets.delete(`${owner}:${key}`),
    },emit:(channel,args)=>{
      if(this.ownerKey!==owner || this.ownerGeneration!==generation || this.ownerSuspended || this.closing)return;
      this.transport.publish(channel,args);void this.remote?.publish(channel,args[0]).catch(()=>{});
      if(channel==='maker:status-changed')this.remote?.refreshPresence();
    }});
    const endpoints=()=>((this.auth.snapshot().session?.realm??this.region)==='cn'?chinaEndpoints:globalEndpoints);
    this.account=new TerminalRemoteAccountService({getApiBaseUrl:()=>endpoints().deviceLinkApiBaseUrl,getAuthBaseUrl:()=>endpoints().authApiBaseUrl,getToken:async()=>this.auth.getAccessToken(),getOwnerScope:()=>this.auth.snapshot().session?scope():null});
    this.membership=new TerminalMembershipService({account:this.account,getOwnerScope:()=>this.auth.snapshot().session?scope():null,getDeviceId:()=>this.settings.deviceId,onRevoked:member=>{void this.agents.host.abortControllers(peer=>{const source=parseProviderSharePeer(peer);return source?.role==='guest'&&source.shareId===member.shareId&&source.memberId===member.memberId;});}});
    const guestAllowed=(providerId:string,controller:string,model?:string)=>{const access=this.membership.guestAccess(controller);return access?.providerId===providerId&&this.agents.enabled(providerId)&&(!model||this.modelGrants.allows(providerId,model,access.memberId));};
    this.agents=new TerminalRemoteAgentService({profileDir:ownerDir,getOwnerScope:scope,readProviders:()=>this.tasks.models.views(),startHosted:input=>this.tasks.startHosted(input),isAgentAvailable:kind=>this.tasks.isAgentAvailable(kind),modelAllowed:(id,model)=>this.modelGrants.allows(id,model),
      shared:{
        providerAccess:{
          resolve:async(kind,model,providerId,controller)=>resolveGuestProviderId(await this.tasks.models.views(),this.membership.guestAccess(controller)?.providerId,id=>guestAllowed(id,controller,model),kind,model,providerId),
          isAllowed:guestAllowed,
          models:async(kind,id,controller)=>guestProviderModelIds(await this.tasks.models.views(),id,kind).filter(model=>guestAllowed(id,controller,model)),
          restricted:(id,controller)=>{try{const rule=this.modelGrants.read(id,this.membership.guestAccess(controller)?.memberId);return rule.models!==null||rule.providerModels!==null;}catch{return true;}},
        },
        bindGuestProviderRoute:createGuestProviderRouteBinder({registerRoute:(...args)=>this.guestRoutes.register(...args),modelAllowed:(id,model,session)=>this.guestRoutes.modelAllowed(id,model,session),readProviders:()=>this.tasks.models.views(),guestAccess:controller=>this.membership.guestAccess(controller),ownerAllowed:()=>false,providerAllowed:id=>this.agents.enabled(id),modelAccess:this.modelGrants}),
      },log:logger});
    this.groups=new TerminalProviderGroups({profileDir:ownerDir,getOwnerScope:scope,invoke:(deviceId,channel,args)=>this.invokeRemoteResult(deviceId,channel,args),isRemoteAllowed:id=>this.agents.enabled(id),
      listLocalProviders:()=>this.agents.views(),localDeviceName:()=>this.settings.snapshot().effective.deviceName,localAppVersion:()=>VERSION,
      listDevices:async()=>(await this.remote.listDevices()).map(device=>({...device,controlEnabled:true})),
      readDeviceProviders:deviceId=>readDeviceProviderViews((peer,channel,args)=>this.invokeRemoteResult(peer,channel,args),deviceId),
      listReceivedShares:()=>this.membership.receivedShares(),isMobilePlatform:platform=>platform==='ios'||platform==='android',listBindings:()=>({}),isTurnRunning:()=>false,sessionGroup:async()=>null});
    this.resources=new TerminalResources(this.tasks);
    registerRemoteManagementResources(this.resources.registry,{agent:this.agents,groups:this.groups,membership:this.membership,modelGrants:this.modelGrants,account:this.account,deviceId:this.settings.deviceId,apiBaseUrl:()=>endpoints().deviceLinkApiBaseUrl,remoteEnabled:()=>this.settings.snapshot().effective.remoteEnabled});
    this.ssh=new TerminalSshService(this.profileDir,(channel,payload)=>{if(scope()===`${owner}:${generation}`&&!this.ownerSuspended)this.transport.publish(channel,[payload]);});
    try { await this.ssh.open(); } catch { logger.warn('SSH_CONFIGURATION_UNAVAILABLE'); }
    this.ssh.registerResources(this.resources.registry);
    const binaries=await this.engines.allStatus();
    await this.tasks.refreshBinaries(Object.fromEntries(binaries.filter(status=>status.binary).map(status=>[status.kind,status.binary!])));
    this.scheduler=new TerminalSchedulerHost({profileDir:ownerDir,tasks:this.tasks,logger,
      canDispatch:()=>this.ownerKey===owner&&this.ownerGeneration===generation&&!this.ownerSuspended&&!this.closing,
      emit:(channel,args)=>{if(this.ownerKey!==owner||this.ownerGeneration!==generation||this.ownerSuspended||this.closing)return;this.transport.publish(channel,args);void this.remote.publish(channel,args[0]).catch(()=>{});}});
    this.scheduler.registerResources(this.resources.registry);

  }

  private async invokeRemoteResult(deviceId:string,channel:string,args:unknown[]) {
    try {
      let peer=deviceId;
      if(deviceId.startsWith('share:')){
        const shares=await this.membership.list();
        const share=shares.received.find(value=>value.shareId===deviceId.slice(6)&&value.status==='active');
        if(!share)throw new Error('[REMOTE_AGENT_SHARE_REMOVED] Shared provider is unavailable');
        peer=providerShareHostPeer(share.shareId,share.hostDeviceId);
      }
      return {ok:true,result:await this.remote.invoke(peer,channel,args)};
    } catch(error) {return {ok:false,error:{code:(error as {code?:string}).code,message:error instanceof Error?error.message:'Remote operation failed'}};}
  }

  async invoke(channel: string,args: unknown[],context: InvocationContext): Promise<unknown> {
    const local=context.source==='local';
    if(this.closing)throw new Error('SERVICE_STOPPING');
    context.assertCurrent?.();
    if(channel.startsWith('terminal:')&&!local)throw new Error('LOCAL_ONLY_COMMAND');
    if(channel==='terminal:status')return {
      version:VERSION,startedAt:this.startedAt,deviceId:this.settings.deviceId,deviceName:this.settings.snapshot().effective.deviceName,
      settings:this.settings.snapshot().effective,vault:this.secrets.status(),auth:this.auth.snapshot(),connection:this.remote.getStatus(),installation:await this.manager.status(),
    };
    if(channel==='terminal:engines:list')return this.engines.allStatus();
    if(channel==='terminal:engines:refresh'){const statuses=await this.engines.allStatus();await this.tasks.refreshBinaries(Object.fromEntries(statuses.filter(status=>status.binary).map(status=>[status.kind,status.binary!])));return statuses;}
    if(['terminal:engines:install','terminal:engines:update','terminal:engines:repair'].includes(channel)){
      const kind=valueString(args[0]);if(!['claude-code','codex','pi'].includes(kind))throw new Error('INVALID_ENGINE');
      const result=channel.endsWith(':update')?await this.engines.update(kind as EngineKind,context.signal):channel.endsWith(':repair')?await this.engines.repair(kind as EngineKind,context.signal):await this.engines.install(kind as EngineKind,{signal:context.signal});
      await this.tasks.refreshBinaries({[kind]:result.binary??undefined});return result;
    }
    if(channel.startsWith('terminal:ssh:'))return this.ssh.invoke(channel.slice('terminal:ssh:'.length),args,context);
    if(channel==='terminal:settings:get')return this.settings.snapshot();
    if(channel==='terminal:settings:update'){const result=await this.settings.update(args[0]);if(this.auth.snapshot().session)this.remote.refreshPresence();return result;}
    if(channel==='terminal:settings:reset')return this.settings.reset(args[0] as string[]);
    if(channel==='terminal:vault:initialize'){
      await this.secrets.initialize(valueString(args[0]) as 'machine'|'passphrase',args[1]===undefined?undefined:valueString(args[1]));
      await this.auth.initialize();return this.secrets.status();
    }
    if(channel==='terminal:vault:unlock'){await this.secrets.unlock(valueString(args[0]));await this.auth.initialize();return this.secrets.status();}
    if(channel==='terminal:auth:status')return this.auth.snapshot();
    if(channel==='terminal:auth:authorization')return this.authorization;
    if(channel==='terminal:auth:begin')return this.auth.beginLogin();
    if(channel==='terminal:auth:email')return this.auth.discoverEmail(valueString(args[0]));
    if(channel==='terminal:auth:organization')return this.auth.discoverOrganization(valueString(args[0]));
    if(channel==='terminal:auth:realm')return this.auth.confirmRealm(args[0]===true);
    if(channel==='terminal:auth:request-code')return this.auth.requestCode(valueString(args[0]) as 'email'|'phone',valueString(args[1]));
    if(channel==='terminal:auth:captcha-start')return this.auth.startCaptcha(valueString(args[0]) as 'email'|'phone',valueString(args[1]),{lang:this.settings.snapshot().effective.language});
    if(channel==='terminal:auth:captcha-complete')return this.auth.completeCaptcha(valueString(args[0]),valueString(args[1]));
    if(channel==='terminal:auth:memberships')return this.auth.memberships();
    if(channel==='terminal:auth:switch-membership' || channel==='terminal:auth:membership')return this.auth.switchMembership(valueString(args[0]));
    if(channel==='terminal:auth:verify')return this.auth.verifyCode(valueString(args[0]));
    if(channel==='terminal:auth:select')return this.auth.selectAccount(valueString(args[0]));
    if(channel==='terminal:auth:binding-code')return this.auth.requestBindingCode(valueString(args[0]));
    if(channel==='terminal:auth:binding-verify')return this.auth.verifyBinding(valueString(args[0]));
    if(channel==='terminal:auth:sso-code')return this.auth.requestSsoVerificationCode();
    if(channel==='terminal:auth:sso-verify')return this.auth.verifySsoVerification(valueString(args[0]));
    if(channel==='terminal:auth:cancel'){this.authorization=null;return this.auth.cancel();}
    if(channel==='terminal:auth:refresh')return this.auth.refresh();
    if(channel==='terminal:auth:logout' || channel==='terminal:auth:switch') {
      if(this.tasks.isBusy())throw new Error('STOP_RUNNING_TASKS_BEFORE_ACCOUNT_CHANGE');
      return channel==='terminal:auth:logout'?this.auth.logout({all:args[0]===true}):this.auth.switchAccount(valueString(args[0]));
    }
    if(channel==='terminal:auth:authorize'){
      const kind=valueString(args[0]);if(kind!=='sso'&&kind!=='social')throw new Error('INVALID_AUTH_ACTION');
      void this.auth.authorize(kind,valueString(args[1])).catch(()=>logger.warn('AUTHORIZATION_FAILED'));
      return {started:true};
    }
    if(channel==='terminal:devices:list')return this.auth.snapshot().session ? this.remote.listDevices() : [];
    if(channel==='terminal:devices:connect'){
      return this.remote.connect(valueString(args[0]));
    }
    if(channel==='terminal:devices:disconnect'){const peer=valueString(args[0]);this.files.stop(peer);this.browser.stop(peer);this.remote.disconnect(peer);return null;}
    if(channel==='terminal:devices:watch'){
      const id=randomUUID();const peer=valueString(args[0]);const task=args[1]===undefined?undefined:valueString(args[1]);
      const dispose=await this.remote.subscribe(peer,task?['sessions',`session:${task}`]:['sessions']);
      this.subscriptions.set(id,dispose);return {id};
    }
    if(channel==='terminal:devices:unwatch'){const id=valueString(args[0]);this.subscriptions.get(id)?.();this.subscriptions.delete(id);return null;}
    if(channel==='maker:provider:list')return this.groups.decorate(await this.agents.views());
    if(channel==='terminal:models:add'){
      const value=object(args[0]);const name=valueString(value.name);const model=valueString(value.model);const baseUrl=valueString(value.baseUrl);
      const id=`custom-${randomUUID()}`;
      await this.tasks.models.saveProvider({id,name,auth:{method:value.apiKey?'apiKey':'none'},runtimes:{pi:{baseUrl,wireProtocol:'openai-chat',models:[{id:model,name:model}]}}},{pi:value.apiKey?valueString(value.apiKey):''},true);
      await this.tasks.models.setDefault({agentKind:'pi',providerId:id,model});return {id};
    }
    if(channel==='terminal:models:default'){await this.tasks.models.setDefault(args[0]);return this.tasks.models.snapshot();}
    if(channel==='terminal:service:stop'){setImmediate(()=>void this.close());return {stopping:true};}
    if(channel==='terminal:service:install')return this.manager.install();
    if(channel==='terminal:service:uninstall')return this.manager.uninstall();
    await this.ownerChange;
    if(this.ownerSuspended)throw new Error('ACCOUNT_CHANGE_IN_PROGRESS');
    context.assertCurrent?.();
    const result=this.scheduler.channels.includes(channel)?await this.scheduler.invoke(channel,args,context)
      :channel.startsWith('maker:file-browser:')||channel.startsWith('fs:')||channel==='file-browser:remote-op'?await this.browser.invoke(channel,args,context)
      :channel.startsWith('maker:remote-resources:')?await this.resources.invoke(channel,args,context):await this.tasks.invoke(channel,args,context);
    context.assertCurrent?.();
    return result;
  }

  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      clearInterval(this.refreshTimer);this.remote?.stop();
      this.files?.stop();this.browser?.stop();this.resources?.close();this.membership?.close();this.guestRoutes?.close();await this.modelGrants?.close();await this.agents?.stop();await this.groups?.close();await this.ssh?.close();
      await this.auth?.cancel();await this.ownerChange;
      for(const dispose of this.subscriptions.values())dispose();this.subscriptions.clear();
      await this.scheduler?.close();await this.tasks?.close();await this.secrets.flush();this.secrets.lock();await this.transport.close();this.stopWait();
    })();
    return this.closing;
  }
}
