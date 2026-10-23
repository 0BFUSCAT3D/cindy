/** Explicit native acceptance only: never uses a real provider or login.
 * CINDY_CODEX_TEST_BINARY=/absolute/codex vitest run src/models/runtime.native.test.ts
 * A private fake Responses server + real exec-server prove the guest runtime
 * actually routes requests through the task host, with an isolated CODEX_HOME. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { Logger, AgentSessionHandle } from '@cindy/maker-core';
import { TerminalTaskHost } from '../tasks/host.js';

const binary=process.env.CINDY_CODEX_TEST_BINARY;
const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return logger;}};
describe.skipIf(!binary)('terminal real Codex guest runtime',()=>{
  it('uses the selected provider and guest-only runtime directory',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-guest-probe-'));
    const guestHome=path.join(root,'guest'),shadow=path.join(root,'shadow'),work=path.join(root,'work');
    await Promise.all([guestHome,shadow,work,path.join(root,'exec-home')].map(dir=>mkdir(dir,{recursive:true})));
    let requests=0,validAuth=true;const bodies:string[]=[];
    const api=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      if(!req.url?.endsWith('/responses')){res.writeHead(404).end('{}');return;}
      requests++;validAuth&&=req.headers.authorization==='Bearer fake-guest-upstream-key';bodies.push(body);
      const item={type:'message',id:'msg-fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'GUEST_ROUTE_OK',annotations:[]}]};
      const events=[{type:'response.created',response:{id:'r-fixture',status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r-fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
      res.writeHead(200,{'content-type':'text/event-stream','connection':'close'}).end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });});
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
    const reserve=net.createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));
    const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
    const child=spawn(binary!,['exec-server','--listen',`ws://127.0.0.1:${port}`],{env:{...process.env,CODEX_HOME:path.join(root,'exec-home')},stdio:'ignore'});
    const secrets=new Map<string,string>();let granted=true;
    const host=new TerminalTaskHost({profileDir:path.join(root,'profile'),secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}},logger,emit(){},binaryPaths:{codex:binary},nativeStatus:async()=>({authenticated:false}),authorizeGuestRequest:async()=>granted});
    let handle:AgentSessionHandle|undefined;
    try {
      const until=Date.now()+10_000;
      for(;;){if(await new Promise<boolean>(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>{socket.destroy();resolve(false);});}))break;if(Date.now()>until)throw new Error('EXEC_SERVER_START_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,25));}
      await host.invoke('maker:provider:custom:create',[{id:'fixture',name:'Fixture',auth:{method:'apiKey'},runtimes:{codex:{baseUrl:`http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1`,models:[{id:'fixture-model',name:'Fixture model'}]}}},{codex:'fake-guest-upstream-key'}]);
      handle=await host.startHosted({kind:'codex',hostSessionId:'native_guest_probe',shadowDir:shadow,mirrorRoot:root,options:{model:'fixture-model',providerId:'fixture',permissionMode:'bypassPermissions'},workspace:{workingDir:work,extraDirs:[],writableDirs:[],platform:process.platform,shell:process.platform==='win32'?'powershell':'zsh',isGitRepo:false},tunnel:{url:`http://127.0.0.1:${port}`,token:'fixture-exec'},mcpServers:[],guest:true,guestHome,guestProvider:{providerId:'fixture',modelIds:['fixture-model'],routeToken:'fixture-route'}});
      let reply='';let failed=false;
      const complete=(async()=>{for await(const event of handle!.events()){if(event.type==='text')reply+=typeof event.data==='string'?event.data:String((event.data as {text?:string})?.text??'');if(event.type==='error')failed=true;if(event.type==='done')break;}})();
      await handle.send({type:'user',content:'Reply with GUEST_ROUTE_OK. Do not call tools.'});await complete;
      expect(failed).toBe(false);expect(reply).toContain('GUEST_ROUTE_OK');expect(requests).toBeGreaterThan(0);expect(validAuth).toBe(true);
      const config=await readFile(path.join(guestHome,'config.toml'),'utf8').catch(()=> '');expect(config.includes('fake-guest-upstream-key')).toBe(false);
      expect((await readdir(guestHome,{recursive:true})).some(file=>String(file).endsWith('.jsonl'))).toBe(true);
      expect(await readdir(path.join(root,'profile','engines','codex')).catch(()=>[])).toEqual([]);
      expect(bodies.every(body=>JSON.parse(body).model==='fixture-model')).toBe(true);
      granted=false;
      await expect(host.startHosted({kind:'codex',hostSessionId:'revoked_guest_probe',shadowDir:shadow,mirrorRoot:root,options:{model:'fixture-model',providerId:'fixture'},workspace:{workingDir:work,extraDirs:[],writableDirs:[],platform:process.platform,shell:'zsh',isGitRepo:false},tunnel:{url:`http://127.0.0.1:${port}`,token:'fixture-exec'},mcpServers:[],guest:true,guestHome,guestProvider:{providerId:'fixture',modelIds:['fixture-model'],routeToken:'fixture-route'}})).rejects.toThrow('GUEST_PROVIDER_UNAUTHORIZED');
    }finally{await handle?.close().catch(()=>{});await host.close();child.kill();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
  },90_000);
});
