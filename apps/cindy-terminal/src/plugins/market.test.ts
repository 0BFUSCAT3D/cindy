/** Integration tier: exercise the terminal resource→download→native receipt
 * path. A substituted package or interrupted provenance write must never grant
 * enterprise credentials; restart must recover a committed exact package. */
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { RemoteResourceRegistry } from '@cindy/device-link';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { TerminalSecretStore } from '../secrets.js';
import { TerminalPlugins } from './host.js';
import { TerminalPluginAccount } from './account.js';
import { TerminalPluginMarket } from './market.js';
import { registerPluginResources } from './resources.js';

it('pins market downloads, recovers the approved package after ledger interruption, and binds organization credentials',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-market-'));
  const vault=new TerminalSecretStore(path.join(directory,'vault'));await vault.open();await vault.initialize('machine');
  const member={id:'fixture-member',kind:'org' as const,role:'member' as const,displayName:'Fixture',email:null,orgId:'fixture-org',orgName:'Fixture'};
  const manifest={schemaVersion:2,id:'fixture-market',name:'Fixture market',version:'1.0.0',kind:'chip',entry:'main.js',settingsHtml:'settings.html',slots:['tool','network'],tools:[{name:'check',description:'Check'}],network:{hosts:['accounts.example.com','api.example.com'],secrets:[
    {key:'account',label:'Account',source:'oauth',inject:{header:'Authorization',format:'Bearer {value}',hosts:['accounts.example.com']},oauth:{authorizeUrl:'https://accounts.example.com/authorize',tokenUrl:'https://accounts.example.com/token',clientId:'fixture-client',tokenBroker:'jira'}},
    {key:'identity',label:'Organization',source:'oidc-token',inject:{header:'Authorization',format:'Bearer {value}',hosts:['api.example.com']}},
  ]}};
  const zip=new JSZip();zip.file('ghost.json',JSON.stringify(manifest));zip.file('main.js','cindy.onHostMessage(() => {});');zip.file('settings.html','<p>Fixture settings</p>');const bytes=await zip.generateAsync({type:'nodebuffer'});
  const plugin={id:'caaaaaaaaaaaaaaaaaaaaaaaa',ghostId:manifest.id,name:manifest.name,description:null,author:null,scope:'organization',namespace:'fixture-org',organizationId:member.orgId,defaultInstall:false,currentRelease:{id:'fixture-release',version:'1.0.0',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,publishedAt:'2026-10-23T00:00:00.000Z',icon:null}};
  let host:TerminalPlugins,substitute=true;const organizations:string[]=[];
  const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid',oauthBrokerApiBaseUrl:'https://broker.example.invalid'}),membership:()=>member,token:()=> 'synthetic-login',refresh:async()=>{},assertCurrent:()=>{},
    onOrganization:organization=>{organizations.push(organization.organizationId);host.identity.rememberOrganization(organization);},
    fetch:async(url,init)=>{
      const request=new URL(String(url));expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-login');
      if(request.pathname==='/api/plugins')return Response.json({schemaVersion:2,plugins:[plugin],removals:[],nextCursor:null,currentOrganization:{organizationId:member.orgId,orgSlug:'fixture-org',pluginPrefix:'fixture'}});
      if(request.pathname.endsWith('/download'))return Response.json({pluginId:plugin.id,releaseId:plugin.currentRelease.id,ghostId:plugin.ghostId,namespace:plugin.namespace,url:'https://storage.example.invalid/package.cindy',expiresAt:'2099-01-01T00:00:00.000Z',sha256:plugin.currentRelease.sha256,sizeBytes:bytes.length});
      if(request.pathname.startsWith('/api/plugins/'))return Response.json({schemaVersion:2,plugin:{...plugin,currentRelease:{...plugin.currentRelease,manifest:{...manifest,namespace:plugin.namespace}}}});
      if(request.pathname==='/api/auth/connections/token'){expect(JSON.parse(String(init?.body))).toEqual({audience:'fixture-org:fixture-market'});return Response.json({token:'synthetic-connection',expiresIn:600,audience:'fixture-org:fixture-market'});}
      expect(request.hostname).toBe('broker.example.invalid');expect(request.pathname).toBe('/api/integrations/jira/oauth/refresh');return Response.json({accessToken:'synthetic-broker-access',expiresIn:600});
    },
  });
  const options={root:path.join(directory,'owner'),runtimeDirectory:directory,executablePath:'unused',account,secrets:vault,assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},receive:async()=>({}),cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false as const,reason:'cancelled' as const}),writeSaveDeposit:async()=>null}};
  host=new TerminalPlugins(options);
  const market=new TerminalPluginMarket({root:options.root,host,account,assertCurrent:()=>{},download:async input=>{
    expect(input.init?.headers).toBeUndefined();await input.beforeDispatch?.();return {response:new Response(new Uint8Array(substitute?Buffer.alloc(bytes.length):bytes)),finalUrl:input.url,release:async()=>{}};
  }});
  try{
    await host.ready;
    await expect(market.prepare(plugin.id,plugin.currentRelease.id,'controller')).rejects.toThrow('PLUGIN_MARKET_PACKAGE_MISMATCH');
    expect(await host.list()).toEqual([]);substitute=false;
    const registry=new RemoteResourceRegistry();market.register(registry);registerPluginResources(registry,host);
    const context={controllerDeviceId:'controller',assertCurrent:()=>{}},client={protocolVersion:1 as const,primitives:['text','actions'],locale:'en'};
    const resource=await registry.get(context,{client,ref:{collectionId:'plugin-market',kind:'market-plugin',id:plugin.id}});
    const pending=await registry.invoke(context,{client,collectionId:'plugin-market',resourceRef:resource.ref,actionId:resource.actions![0].id});
    const navigation=pending.effects[0];if(navigation.kind!=='navigate'||navigation.target.kind!=='resource')throw new Error('Expected permission resource');
    expect(await host.list()).toEqual([]);
    const write=vi.spyOn(host.identity.ledger,'upsertInstallation').mockImplementationOnce(()=>{throw new Error('Synthetic ledger interruption');});
    await expect(registry.invoke(context,{client,collectionId:'plugins',resourceRef:navigation.target.ref,actionId:'confirm-install'})).rejects.toThrow('Synthetic ledger interruption');write.mockRestore();
    const installed=(await host.list())[0],id=installedGhostStoragePart(installed);
    expect(host.identity.brokerAllowed(id)).toBe(false);
    await host.close();host=new TerminalPlugins(options);await host.ready;
    const restored=(await host.list())[0];expect(restored.manifest.id).toBe(plugin.ghostId);
    expect(host.identity.record(restored)).toMatchObject({installed:true,releaseId:plugin.currentRelease.id,sha256:plugin.currentRelease.sha256});
    expect(host.identity.brokerAllowed(id)).toBe(true);expect(host.identity.hostAllowed(id)).toBe(false);
    const connection=host.identity.connection(id);expect(connection).toMatchObject({audience:'fixture-org:fixture-market',allowedHosts:['api.example.com']});
    expect(await account.tokens.getToken(connection!)).toBe('synthetic-connection');
    expect(await account.broker.refresh('jira',{refreshToken:'synthetic-refresh'})).toMatchObject({ok:true,bundle:{accessToken:'synthetic-broker-access'}});
    const prepared=host.pendingFor('controller');expect(prepared).toEqual([]);expect(organizations.length).toBeGreaterThan(0);
    const savedOrg=member.orgId;member.orgId='foreign-org';expect(host.identity.brokerAllowed(id)).toBe(false);expect(host.identity.connection(id)).toBeNull();member.orgId=savedOrg;
    await host.uninstall(id);expect(host.identity.ledger.isDefaultInstallSuppressed(member.id,plugin.id)).toBe(true);
  }finally{await market.close();await host!.close();account.close();vault.lock();await rm(directory,{recursive:true,force:true});}
});
