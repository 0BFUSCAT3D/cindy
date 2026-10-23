/**
 * Production entries: encrypted store and authenticated local service transport.
 * Rule: credentials-and-local-storage + the terminal host's single-writer contract.
 * Coverage gap: neither exists on the Desktop transport. Minimal failures: wrong
 * passphrase, a second host, or an unauthenticated pipe client. Tier: integration
 * because the test uses a private temporary directory and actual local sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildLegacyAttachmentOssRef, RemoteResourceRegistry } from '@cindy/device-link';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TerminalKnowledge } from './knowledge.js';
import { registerKnowledgeResources } from './knowledge-resources.js';
import type { Logger } from '@cindy/maker-core';
import { TerminalMediaTransfer } from './media-transfer.js';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer, connectTerminal } from './transport.js';
import { TerminalService } from './service.js';
import { socketPath, privateDirectory } from './platform.js';
import { TerminalProtectedInput } from './protected-input.js';
import { inputHandoffPresentation, type InputHandoffSnapshot } from '@cindy/device-link';

describe('terminal private host', () => {
  let directory: string;
  beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(),'cindy-terminal-host-')); });
  afterAll(async () => { await fs.rm(directory,{recursive:true,force:true}); });

  // Linux ARM64 native restart accepted IPC while listen() was still releasing
  // its lock, before initialize() had assigned tasks. Hold that exact boundary;
  // the real authenticated status request must wait and then return a full host.
  it('holds early authenticated requests until the host is initialized', async () => {
    const root=path.join(directory,'startup-barrier'),service=new TerminalService(root);
    let publish!:()=>void,release!:()=>void,entered!:()=>void;
    const published=new Promise<void>(resolve=>{publish=resolve;});
    const releasing=new Promise<void>(resolve=>{release=resolve;});
    const requested=new Promise<void>(resolve=>{entered=resolve;});
    const listen=service.transport.listen.bind(service.transport);
    service.transport.listen=async()=>{await listen();publish();await releasing;};
    const boundary=service.transport as unknown as {invoke(channel:string,args:unknown[],device?:string):Promise<unknown>};
    const invoke=boundary.invoke.bind(boundary);
    boundary.invoke=(...args)=>{const pending=invoke(...args);entered();return pending;};
    const starting=service.start();let client:Awaited<ReturnType<typeof connectTerminal>>|undefined;
    try{
      await published;client=await connectTerminal(root);
      let settled=false;
      const status=client.invoke('terminal:status').then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
      void status.catch(()=>{});
      await requested;await new Promise<void>(resolve=>setImmediate(resolve));
      expect(settled).toBe(false);
      release();await starting;
      expect(await status).toMatchObject({busy:false,deviceId:expect.any(String),version:expect.any(String)});
    }finally{release();await starting.catch(()=>{});client?.close();await service.close();}
    // This case opens the full private profile, including native Windows ACL
    // commands. Keep the local 5s budget while allowing the Windows CI host IO.
  },process.platform==='win32'?30_000:5_000);

  // Failed initialization happens after the private askpass listener starts.
  // The old catch closed only IPC, leaving a detached daemon alive forever.
  it('closes private listeners and finishes the host after failed initialization',async()=>{
    const root=path.join(directory,'failed-start'),owner=path.join(root,'owners',createHash('sha256').update('guest').digest('hex').slice(0,32));
    await privateDirectory(owner);await fs.writeFile(path.join(owner,'models.json'),'{invalid json', {mode:0o600});
    const listeners=()=>((process as unknown as {_getActiveHandles():Array<{address?:()=>unknown}>})._getActiveHandles()).flatMap(handle=>{const address=handle.address?.();return typeof address==='string'&&address.includes('cindy-ih-')?[address]:[];});
    const before=new Set(listeners()),service=new TerminalService(root);let stopped=false;void service.stopped.then(()=>{stopped=true;});
    try{
      await expect(service.start()).rejects.toThrow();
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(listeners().filter(socket=>!before.has(socket))).toEqual([]);expect(stopped).toBe(true);
      await expect(connectTerminal(root)).rejects.toThrow('SERVICE_NOT_RUNNING');
    }finally{await service.close().catch(()=>{});}
  },process.platform==='win32'?30_000:5_000);

  // Existing GUI attachments use signed OSS URLs. A corrupt or cancelled
  // transfer must never be adopted, and account tokens belong only on the API.
  it('streams verified attachments without forwarding account credentials to storage', async () => {
    const bytes=Buffer.from('attachment content');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    let corrupt=false,deleted=0,uploaded:Buffer|undefined;
    const transfer=new TerminalMediaTransfer({ownerDir:path.join(directory,'media'),getOwnerScope:()=> 'owner',getToken:async()=> 'test-only-token',getApiBaseUrl:()=> 'https://api.test',
      fetch:async(input,init)=>{
        const url=new URL(String(input));
        if(url.host==='api.test'){
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-token');
          if(init?.method==='DELETE'){deleted++;return Response.json({deleted:true});}
          return Response.json(url.pathname.endsWith('presign-put')?{putUrl:'https://storage.test/upload',key:'object-key'}:{getUrl:'https://storage.test/download'});
        }
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        if(init?.method==='PUT'){
          uploaded=Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
          expect(new Headers(init.headers).get('x-oss-object-acl')).toBe('private');
          return new Response(null,{status:200});
        }
        return new Response(corrupt?Buffer.from('corrupt'):bytes);
      }});
    const reference=buildLegacyAttachmentOssRef({ossKey:'object-key',mimeType:'text/plain',size:bytes.length,sha256});
    const result=await transfer.resolve(reference,{source:'remote',deviceId:'sender'});
    expect(await fs.readFile(result.path)).toEqual(bytes);
    expect(deleted).toBe(0);
    const handle=await fs.open(result.path,'r');
    try{const sent=await transfer.upload(handle,'text/plain','note.txt');expect(sent.sha256).toBe(sha256);expect(uploaded).toEqual(bytes);}
    finally{await handle.close();}
    await result.afterAcceptance?.();expect(deleted).toBe(1);await result.cleanup();
    corrupt=true;
    await expect(transfer.resolve(reference,{source:'remote',deviceId:'sender'})).rejects.toThrow('ATTACHMENT_INTEGRITY_FAILED');
    expect(await fs.readdir(path.join(directory,'media','attachment-staging'))).toEqual([]);
  });

  it('persists encrypted credentials and rejects the wrong passphrase', async () => {
    const dir=path.join(directory,'passphrase');
    const store=new TerminalSecretStore(dir);await store.open();
    await store.initialize('passphrase','test-only-passphrase');
    await store.set('provider','invalid-test-key');
    expect((await fs.readFile(path.join(dir,'secrets.enc'),'utf8')).includes('invalid-test-key')).toBe(false);
    store.lock();await expect(store.get('provider')).rejects.toThrow('VAULT_LOCKED');
    const restored=new TerminalSecretStore(dir);await restored.open();
    await expect(restored.unlock('wrong-test-passphrase')).rejects.toThrow('VAULT_UNLOCK_FAILED');
    await restored.unlock('test-only-passphrase');
    expect(await restored.get('provider')).toBe('invalid-test-key');
    await restored.delete('provider');expect(await restored.get('provider')).toBeNull();
    restored.lock();
  // Native integration: the first Windows ACL operation starts Windows
  // PowerShell on a cold runner; it has its own 15-second process deadline.
  },process.platform==='win32'?30_000:5_000);

  it('automatically unlocks only an explicitly selected machine-key store', async () => {
    const dir=path.join(directory,'machine');
    const store=new TerminalSecretStore(dir);await store.open();
    expect(store.status().initialized).toBe(false);
    await store.initialize('machine');
    // Integration: plugin refresh writes must commit before returning and must
    // not be overwritten by an older queued account write (shared-vault rule).
    const earlier=store.set('one','old-value');store.setSync('one','invalid-one');
    const second=store.set('two','invalid-two');store.setSync('removed','synthetic');store.deleteSync('removed');
    await Promise.all([earlier,second]);
    expect(store.getSync('one')).toBe('invalid-one');expect(store.getSync('removed')).toBeNull();
    store.lock();const next=new TerminalSecretStore(dir);await next.open();
    expect(await next.get('one')).toBe('invalid-one');expect(await next.get('two')).toBe('invalid-two');
    next.lock();expect(()=>next.getSync('one')).toThrow('VAULT_LOCKED');expect(()=>next.setSync('one','changed')).toThrow('VAULT_LOCKED');
  });

  it('authenticates calls, fans out events, retains the owner and redacts errors', async () => {
    const dir=path.join(directory,'transport');let calls=0;
    const server=new TerminalTransportServer(dir,async channel => {
      calls++;
      if(channel==='test:failure') throw new Error('invalid-test-key in provider error');
      return { channel };
    });
    await server.listen();
    const client=await connectTerminal(dir);
    const second=await connectTerminal(dir);
    try {
      expect(await client.invoke('test:status')).toEqual({channel:'test:status'});
      const pushed=new Promise(resolve=>second.subscribe((channel,args)=>resolve({channel,args})));
      client.close();server.publish('test:changed',[42]);
      expect(await pushed).toEqual({channel:'test:changed',args:[42]});
      await expect(second.invoke('test:failure')).rejects.toThrow('OPERATION_FAILED');
      const duplicate=new TerminalTransportServer(dir,async()=>null);
      await expect(duplicate.listen()).rejects.toThrow('SERVICE_ALREADY_RUNNING');
      await duplicate.close();
      expect(await second.invoke('test:owner')).toEqual({channel:'test:owner'});
      const unauthenticated=net.createConnection(socketPath(dir));
      await once(unauthenticated,'connect');
      const closed=once(unauthenticated,'close');
      unauthenticated.write(JSON.stringify({type:'invoke',id:'attack',channel:'test:status',args:[]})+'\n');
      await closed;
      expect(calls).toBe(3);
    } finally { client.close();second.close();await server.close(); }
    expect(await fs.stat(path.join(dir,'service.json')).catch(()=>null)).toBeNull();
    if(process.platform!=='win32') await fs.rm(path.dirname(socketPath(dir)),{recursive:true,force:true});
  });

  it('serializes simultaneous stale-owner takeovers without unlinking the winner socket', async () => {
    const dir = path.join(directory, 'concurrent-takeover');
    await privateDirectory(dir);
    await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify({ version: 1, pid: 2147483647, socket: socketPath(dir), key: '0'.repeat(64), instance: 'dead-owner' }), { mode: 0o600 });
    const first = new TerminalTransportServer(dir, async () => 'first');
    const second = new TerminalTransportServer(dir, async () => 'second');
    const results = await Promise.allSettled([first.listen(), second.listen()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    const loser = winner === first ? second : first;
    try {
      await loser.close();
      const client = await connectTerminal(dir);
      try { expect(await client.invoke('test:owner')).toBe(winner === first ? 'first' : 'second'); }
      finally { client.close(); }
    } finally { await first.close(); await second.close(); }
    if (process.platform !== 'win32') await fs.rm(path.dirname(socketPath(dir)), { recursive: true, force: true });
  });
});

// Integration: a terminal controller must use the existing signed GUI protocol.
// The entered value reaches the program once, never the plain wire or snapshots;
// an old step cannot be replayed after completion or an owner change.
it('delivers protected input through the signed exchange without recording its value', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-protected-input-'));
  const wire:unknown[]=[],events:unknown[]=[],answers:Array<string|null>=[];
  let active=true;
  const make=(id:string):TerminalProtectedInput=>{
    const secrets=new Map<string,string>();
    return new TerminalProtectedInput({root:path.join(root,id),
      secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}},
      scope:()=>({realm:'global',membershipId:'test-owner',deviceId:id}),
      assertCurrent:()=>{if(!active)throw new Error('OWNER_CHANGED');},remoteEnabled:()=>true,taskExists:async()=>true,
      emit:(channel,payload)=>events.push({channel,payload}),
      invoke:async(_device,_channel,args)=>{wire.push(args);return {ok:true,result:await host.request(id,args[0])};},
    });
  };
  const host=make('host-device'),controller=make('controller-device');
  try {
    host.handoff.startTerminalPrompt({sessionId:'test-task',program:'sudo',command:'sudo -A true',prompt:'Password:',answer:value=>answers.push(value)});
    const snapshot=host.handoff.pendingSnapshots()[0].request as InputHandoffSnapshot;
    const submission={expectedRevision:snapshot.revision,values:{[snapshot.controls.find(control=>control.kind==='text')!.id]:'synthetic-private-value'},action:{kind:'submit' as const}};
    expect(await controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).toEqual({accepted:true});
    expect(answers).toEqual(['synthetic-private-value']);
    expect(JSON.stringify({wire,events})).not.toContain('synthetic-private-value');
    await expect(controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).rejects.toThrow();
    active=false;
    await expect(controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).rejects.toThrow('OWNER_CHANGED');
  } finally {active=true;await controller.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
});


// Tier: integration. The same account records must be visible through resource
// forms and real MCP entry tools; disabled/stale runtimes must not disclose them.
it('shares memory and contacts between real resources and MCP without cross-task disposal', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-knowledge-'));
  const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child:()=>logger};
  let active=true;
  const knowledge=new TerminalKnowledge({root,logger,assertCurrent(){if(!active)throw new Error('OWNER_CHANGED');},changed(){},workingDirs:async()=>[root]});
  const clients:Client[]=[];
  try {
    await knowledge.ready;
    const registry=new RemoteResourceRegistry();registerKnowledgeResources(registry,knowledge);
    const host={controllerDeviceId:'local',assertCurrent(){if(!active)throw new Error('OWNER_CHANGED');}};
    const client={protocolVersion:1,primitives:['text','form'],locale:'zh-CN'};
    await registry.invoke(host,{client,collectionId:'memory',actionId:'create',input:{workingDir:root,type:'project',name:'fixture',title:'验收记录',description:'private fixture',body:'one task must not close another'}});
    const first=await knowledge.createRuntime({sessionId:'one',workingDir:root,agentKind:'codex'});
    const second=await knowledge.createRuntime({sessionId:'two',workingDir:root,agentKind:'codex'});
    await first.close();
    expect((await (await second.memory.getStore(second.scopeKey)).list())[0].frontmatter.title).toBe('验收记录');
    const connect=async(server:ReturnType<typeof second.factories.cindy_contacts>)=>{
      const connection=new Client({name:'acceptance',version:'1'});clients.push(connection);
      const [controller,target]=InMemoryTransport.createLinkedPair();await server.connect(target);await connection.connect(controller);return connection;
    };
    const contacts=await connect(second.factories.cindy_contacts());
    await registry.invoke(host,{client,collectionId:'contacts',actionId:'create',input:{displayName:'Acceptance Person',kind:'person',status:'confirmed',summary:'Private fixture'}});
    const listed=await registry.list(host,{client,collectionId:'contacts'});expect(listed.items).toHaveLength(1);
    const ref=listed.items[0].ref;
    await registry.invoke(host,{client,collectionId:'contacts',resourceRef:ref,actionId:'identity',input:{platform:'email',value:'fixture@example.invalid'}});
    const resolve=()=>contacts.callTool({name:'call_tool',arguments:{name:'contacts_resolve',args:{value:'fixture@example.invalid'}}});
    expect(JSON.stringify(await resolve())).toContain('CONTACTS_NOT_READY');
    await registry.invoke(host,{client,collectionId:'contacts',actionId:'settings',input:{enabled:true}});
    expect(JSON.stringify(await resolve())).toContain('Acceptance Person');
    const memories=await registry.list(host,{client,collectionId:'memory'});expect(memories.items).toHaveLength(1);
    const memory=await connect(second.factories.cindy_memory());
    expect(JSON.stringify(await memory.callTool({name:'call_tool',arguments:{name:'memory_list',args:{}}}))).toContain('验收记录');
    await knowledge.configure({memory:false});
    expect(JSON.stringify(await memory.callTool({name:'call_tool',arguments:{name:'memory_list',args:{}}}))).toContain('MAKER_MEMORY_NOT_READY');
    expect((await registry.list(host,{client,collectionId:'memory'})).items).toHaveLength(1);
    active=false;
    expect(JSON.stringify(await resolve())).not.toContain('Acceptance Person');
    await expect(registry.list(host,{client,collectionId:'memory'})).rejects.toThrow('OWNER_CHANGED');
    await second.close();
  } finally {for(const client of clients)await client.close();await knowledge.close();await fs.rm(root,{recursive:true,force:true});}
});
