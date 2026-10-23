/** Explicit native acceptance only: never uses a real provider or login.
 * CINDY_CODEX_TEST_BINARY=/absolute/codex vitest run src/models/runtime.integration.test.ts
 * A private fake Responses server + real exec-server prove the guest runtime
 * actually routes requests through the task host, with an isolated CODEX_HOME. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { TerminalNativeAccounts } from './native-accounts.js';
import type { Logger, AgentSessionHandle } from '@cindy/maker-core';
import { TerminalTaskHost } from '../tasks/host.js';
import { EngineManager } from '../engines/manager.js';

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

// Native regression: a per-model endpoint must remain behind the private
// credential proxy, and switching a mixed-protocol provider must use the new
// model's API. No real account or external network is used.
describe.skipIf(!process.env.CINDY_PI_TEST_BINARY && process.env.CINDY_TEST_MANAGED_PI !== '1')('terminal real Pi model routes', () => {
  it('keeps endpoint overrides private and switches between native APIs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-pi-route-'));
    let piBinary = process.env.CINDY_PI_TEST_BINARY;
    if (!piBinary) {
      try { piBinary = (await new EngineManager({ profileDir: path.join(root, 'managed') }).install('pi')).binary ?? undefined; }
      catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
      if (!piBinary) { await rm(root, { recursive: true, force: true }); throw new Error('MANAGED_PI_UNAVAILABLE'); }
    }
    const requests: Array<{ path: string; model: string; authorization: string }> = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ path: req.url!, model: body.model, authorization: String(req.headers.authorization) });
      if (req.headers.authorization !== 'Bearer fake-pi-upstream-key') { res.writeHead(401).end('{}'); return; }
      res.setHeader('content-type', 'text/event-stream');
      if (req.url === '/chat-tenant/chat/completions') {
        const chunks = [
          { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PI_CHAT_OK' }, finish_reason: null }] },
          { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
      } else if (req.url === '/responses-tenant/responses') {
        const item = { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PI_RESPONSES_OK', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'r-fixture', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'r-fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const secrets = new Map<string, string>();
    const host = new TerminalTaskHost({ profileDir: path.join(root, 'profile'), logger, emit() {}, binaryPaths: { pi: piBinary },
      secretStore: { get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
      nativeStatus: async () => ({ authenticated: false }),
    });
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create', [{ id: 'mixed', name: 'Mixed APIs', auth: { method: 'apiKey' }, runtimes: { pi: {
        baseUrl: base + '/unused', wireProtocol: 'openai-chat', models: [
          { id: 'chat', name: 'Chat', contextWindow: 128000, piApi: 'openai-completions', route: { baseUrl: base + '/chat-tenant', wireProtocol: 'openai-chat' } },
          { id: 'responses', name: 'Responses', contextWindow: 128000, piApi: 'openai-responses', route: { baseUrl: base + '/responses-tenant', wireProtocol: 'openai-responses' } },
        ],
      } } }, { pi: 'fake-pi-upstream-key' }]);
      const task = await host.invoke('maker:create-session', [{ agentKind: 'pi', providerId: 'mixed', model: 'chat', workingDir: root }]) as { id: string };
      await host.invoke('maker:send', [task.id, { text: 'Reply briefly. Do not call tools.', clientId: 'chat-input' }]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'chat-input'])).toMatchObject({ status: 'completed', finalText: 'PI_CHAT_OK' });
      await host.invoke('maker:set-model', [task.id, 'responses', 'mixed']);
      await host.invoke('maker:send', [task.id, { text: 'Reply again. Do not call tools.', clientId: 'responses-input' }]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'responses-input'])).toMatchObject({ status: 'completed', finalText: 'PI_RESPONSES_OK' });
      expect(requests).toEqual([
        { path: '/chat-tenant/chat/completions', model: 'chat', authorization: 'Bearer fake-pi-upstream-key' },
        { path: '/responses-tenant/responses', model: 'responses', authorization: 'Bearer fake-pi-upstream-key' },
      ]);
      const files = await readdir(path.join(root, 'profile', 'engines', 'pi'), { recursive: true });
      for (const file of files.filter(file => String(file).endsWith('models.json'))) {
        const raw = await readFile(path.join(root, 'profile', 'engines', 'pi', String(file)), 'utf8');
        expect(raw).not.toContain('fake-pi-upstream-key');
        expect(raw).not.toContain('/chat-tenant'); expect(raw).not.toContain('/responses-tenant');
      }
    } finally {
      await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, process.env.CINDY_TEST_MANAGED_PI === '1' ? 180_000 : 30_000);
});

// Real native clients exercise the subscription protocol, while the account
// and HTTP server are synthetic. No system credential is read or changed.
for (const [kind, envKey] of [['pi', 'CINDY_PI_TEST_BINARY'], ['codex', 'CINDY_CODEX_TEST_BINARY'], ['claude-code', 'CINDY_CLAUDE_TEST_BINARY']] as const) {
  it.skipIf(!process.env[envKey] && process.env.CINDY_TEST_NATIVE_SUBSCRIPTIONS !== '1')(`routes ChatGPT through real ${kind} with an owner-private proxy`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-subscription-'));
    let nativeBinary = process.env[envKey];
    if (!nativeBinary) {
      try { nativeBinary = (await new EngineManager({ profileDir: path.join(root, 'managed') }).install(kind)).binary ?? undefined; }
      catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
      if (!nativeBinary) throw new Error('MANAGED_ENGINE_UNAVAILABLE');
    }
    const calls: Array<{ authorization: string; account: string; model: string }> = [];
    const api = createServer(async (req, res) => {
      if (req.url?.startsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({models:[{slug:'gpt-5.4-mini',display_name:'GPT fixture',visibility:'list',supported_in_api:true,context_window:128000,supported_reasoning_levels:[]}]})); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push({ authorization: String(req.headers.authorization), account: String(req.headers['chatgpt-account-id']), model: body.model });
      const item = { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SUBSCRIPTION_NATIVE_OK', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg-fixture', part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg-fixture', delta: 'SUBSCRIPTION_NATIVE_OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.setHeader('content-type', 'text/event-stream'); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', ((url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const target = String(url);
      if (target.startsWith('https://chatgpt.com/backend-api/codex/')) return originalFetch(target.replace('https://chatgpt.com/backend-api/codex', base), init);
      return originalFetch(url, init);
    }) as typeof fetch);
    const secrets = new Map<string, string>([['terminal:native:openai', JSON.stringify({ tokens: { access_token: 'synthetic-native-subscription', account_id: 'synthetic-owner' } })]]);
    const store = { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
    const accounts = new TerminalNativeAccounts({ root, secrets: { getSync: key => secrets.get(key) ?? null, setSync: (key,value) => { secrets.set(key,value); }, deleteSync: key => { secrets.delete(key); } }, binary: async () => null, assertCurrent() {}, changed() {} });
    const errors: unknown[] = [];
    const host = new TerminalTaskHost({ profileDir: path.join(root, 'profile'), logger, emit(channel, args) { if (channel === 'maker:event' && (args[0] as {event?:{type?:string}})?.event?.type === 'error') errors.push(args[0]); }, binaryPaths: { [kind]: nativeBinary }, secretStore: store, nativeStatus: async () => ({ authenticated: false }) });
    try {
      await host.ready; host.models.connectNative(accounts);
      const model = kind === 'codex' ? 'gpt-5.4-mini' : 'chatgpt/gpt-5.4-mini';
      const task = await host.invoke('maker:create-session', [{ agentKind: kind, providerId: 'openai', model, workingDir: root }]) as { id: string };
      await host.invoke('maker:send', [task.id, { text: 'Reply briefly. Do not call tools.', clientId: 'native-subscription-input' }]);
      const receipt = await host.invoke('terminal:tasks:wait', [task.id, 'native-subscription-input']);
      expect(receipt, JSON.stringify({receipt,errors,calls})).toMatchObject({ status: 'completed', finalText: 'SUBSCRIPTION_NATIVE_OK' });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => call.authorization === 'Bearer synthetic-native-subscription' && call.account === 'synthetic-owner' && call.model === 'gpt-5.4-mini')).toBe(true);
    } finally {
      await host.close(); await accounts.close(); vi.unstubAllGlobals(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  }, process.env.CINDY_TEST_NATIVE_SUBSCRIPTIONS === '1' ? 180_000 : 30_000);
}
