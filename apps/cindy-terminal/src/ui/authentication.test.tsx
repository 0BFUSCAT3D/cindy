/** Behavior: the real Ink login surface must discover enabled methods, route
 * every action locally, and keep submitted codes/return URLs out of rendering.
 * Existing controller tests cannot catch missing keyboard routes or visible
 * secrets. Minimal failure: a pasted CAPTCHA fragment echoed by the form.
 * Tier: unit, real Ink + in-memory transport, fake credentials only. */
import React, { act } from 'react';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Instance } from 'ink';
import type { AuthFlowState, TerminalAuthSnapshot } from '@cindy/auth-client';
import type { TerminalClient } from '../contracts.js';
import type { Locale } from './i18n.js';
import { Authentication } from './authentication.js';
import { InteractionView } from './interaction.js';
import { Resources } from './resources.js';
import type { InteractionRequest } from '@cindy/maker-core';
import { Input, terminalText } from './input.js';

const membership = { id:'fictional-member', kind:'personal' as const, role:'owner' as const, displayName:'Example person', email:'person@example.invalid', orgId:null, orgName:null };
const providers = { region:'global' as const, email:true, phone:true, social:['google' as const,'apple' as const,'wechat' as const], attribution:'email' as const };
const initialFlow: AuthFlowState = { step:'identifier', providers };
const instances: Instance[] = [];
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => { if (originalActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT; else actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment; });
afterEach(async () => { for (const instance of instances.splice(0)) { const exited = instance.waitUntilExit(); await act(async()=>instance.unmount()); await exited; instance.cleanup(); } });

function fakeClient(flow: AuthFlowState | null = initialFlow, locked = false) {
  let snapshot: TerminalAuthSnapshot = { accounts:[], session:null, flow, error:null };
  const listeners = new Set<(channel:string,args:unknown[])=>void>();
  let handler: ((channel: string, args: unknown[]) => unknown) | undefined;
  const publish = (next: AuthFlowState, completed = false) => {
    snapshot = { ...snapshot, flow:next, error:null, ...(completed ? { session:{ key:'fictional-key', realm:'global', membership, status:'authenticated' }, accounts:[{key:'fictional-key',realm:'global',membership}] } : {}) };
    for (const listener of listeners) listener('terminal:auth:changed',[snapshot]);
    return snapshot;
  };
  const client: TerminalClient = {
    invoke:vi.fn(async (channel,args = [],deviceId) => {
      if (deviceId) throw new Error('UNEXPECTED_REMOTE_TARGET');
      const handled = handler?.(channel,args);
      if (handled !== undefined) return handled;
      if (channel === 'terminal:status') return {vault:{locked,initialized:true},auth:snapshot};
      if (channel === 'terminal:auth:begin') return publish(initialFlow);
      if (channel === 'terminal:auth:email') return publish({step:'method-choice',email:String(args[0]),methods:[{type:'email_code'}]});
      if (channel === 'terminal:auth:request-code') return publish({step:'verification-code',kind:args[0] as 'email'|'phone',identifier:String(args[1])});
      if (channel === 'terminal:auth:verify') return publish({step:'completed',membership},true);
      if (channel === 'terminal:auth:cancel') { snapshot = {...snapshot,flow:null};return snapshot; }
      throw new Error('UNEXPECTED_CHANNEL');
    }) as TerminalClient['invoke'],
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    close(){},
  };
  return {client,publish,handle:(next:typeof handler)=>{handler=next;}};
}

async function mount(client: TerminalClient, options: {locale?:Locale;sso?:boolean;node?:React.ReactNode} = {}) {
  const frames: string[] = [];
  const input = Object.assign(new PassThrough(), {isTTY:true,setRawMode(){},ref(){},unref(){}});
  const output = Object.assign(new Writable({write(chunk,_encoding,callback){frames.push(String(chunk));callback();}}),{isTTY:true,columns:72,rows:32});
  const onDone = vi.fn(); const onNeedsVault = vi.fn();
  let instance!: Instance;
  await act(async()=>{ instance = render(options.node??<Authentication client={client} locale={options.locale ?? 'en'} sso={options.sso} onDone={onDone} onNeedsVault={onNeedsVault} />,{
    stdin:input as unknown as NodeJS.ReadStream,stdout:output as unknown as NodeJS.WriteStream,stderr:output as unknown as NodeJS.WriteStream,
    debug:true,interactive:true,patchConsole:false,exitOnCtrlC:false,maxFps:1000,
  }); });
  instances.push(instance);
  async function flush() { await act(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});await instance.waitUntilRenderFlush(); }
  await flush();
  return {
    all:()=>terminalText(frames.join('')), latest:()=>frames.map(terminalText).findLast(frame=>frame.trim()) ?? '', onDone,onNeedsVault,
    async press(keys:string){await act(async()=>{input.write(keys);await new Promise<void>(resolve=>setImmediate(resolve));});await flush();},
    async burst(keys:string[]){await act(async()=>{for(const key of keys)input.write(key);});await flush();},
    async update(work:()=>unknown){await act(async()=>{work();});await flush();},
  };
}

describe('terminal authentication surface',()=>{
  it('keeps a long pasted draft inside the input viewport without truncating submission',async()=>{
    const submit=vi.fn();
    function Draft(){const [value,setValue]=React.useState('');return <Input value={value} onChange={setValue} onSubmit={submit} multiline/>;}
    const screen=await mount(fakeClient().client,{node:<Draft/>});
    const draft=Array.from({length:20},(_,i)=>`中文第${i+1}行`).join('\n');
    await screen.press(`\x1b[200~${draft}\x1b[201~`);
    expect(screen.latest()).toContain('中文第20行');
    expect(screen.latest()).not.toContain('中文第1行');
    await screen.press('\x01');
    expect(screen.latest()).toContain('中文第1行');
    await screen.press('\r');
    expect(submit).toHaveBeenCalledExactlyOnceWith(draft);
  });
  // Same-frame input must resolve the visible choice, including each question
  // in a multi-question request. This guards actual authorization decisions.
  it('resolves approval and successive questions using the latest keyboard selection',async()=>{
    const resolve=vi.fn();const host=fakeClient();
    const screen=await mount(host.client,{node:<InteractionView request={{requestId:'permission',kind:'permission',toolName:'fixture',input:{}} as InteractionRequest} locale="en" resolve={resolve} back={()=>{}} busy={false}/>});
    await screen.burst(['\x1b[B','\r']);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({kind:'permission',behavior:'allow'});
    resolve.mockClear();
    const questions=await mount(host.client,{node:<InteractionView request={{requestId:'question',kind:'ask_user_question',questions:[{question:'First',options:[{label:'A'},{label:'B'}]},{question:'Second',options:[{label:'C'},{label:'D'}]}]} as InteractionRequest} locale="en" resolve={resolve} back={()=>{}} busy={false}/>});
    await questions.burst(['\x1b[B','\r','\x1b[B','\r']);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({kind:'ask_user_question',answers:{First:'B',Second:'D'}});
  });
  // Regression from real PTY typing: several input events can precede a React
  // render. Each event must see the previous edit, including Enter's payload.
  it('retains rapid edits received before the next frame',async()=>{
    const host=fakeClient();const screen=await mount(host.client);
    await screen.press('\r');
    await screen.burst(['person@example.invalix','\x7f','d']);
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:email',['person@example.invalid']);
  });
  it('opens the selected row when arrow and Enter share a stream read',async()=>{
    const host=fakeClient();const screen=await mount(host.client);
    await screen.burst(['\x1b[B','\r']);
    await screen.press('+15550001111');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:request-code',['phone','+15550001111']);
  });
  it.each(['en','zh-CN','zh-TW','ja','ko'] as const)('discovers all enabled login methods in %s',async locale=>{
    const host = fakeClient();const screen = await mount(host.client,{locale});
    expect(screen.all()).toContain('Google');expect(screen.all()).toContain('Apple');expect(screen.all()).toContain('SSO');
    expect(screen.all()).not.toContain('method-choice');
    expect(vi.mocked(host.client.invoke).mock.calls.every(call=>call[2] === undefined)).toBe(true);
  });

  it('signs in by email through keyboard actions while the code stays hidden',async()=>{
    const host = fakeClient();const screen = await mount(host.client);
    await screen.press('\r');
    await screen.press('person@example.invalid');await screen.press('\r');
    await screen.press('\r');await screen.press('\r');
    await screen.press('fictional-private-code');
    expect(screen.all()).not.toContain('fictional-private-code');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:email',['person@example.invalid']);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:verify',['fictional-private-code']);
    expect(screen.all()).toContain('Example person');
  });

  it('uses protected CAPTCHA completion and lets a malformed paste be corrected',async()=>{
    const host = fakeClient({step:'method-choice',email:'person@example.invalid',methods:[{type:'email_code'}]});
    const challenge = {id:'fictional-challenge',url:'https://auth.example.invalid/captcha/turnstile?action=email_request_code&theme=light&lang=en',action:'email_request_code',expiresAt:Date.now()+120_000};
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:request-code') throw Object.assign(new Error('CAPTCHA_REQUIRED'),{code:'CAPTCHA_REQUIRED'});
      if (channel === 'terminal:auth:captcha-start') return challenge;
      if (channel === 'terminal:auth:captcha-complete') {
        if (args[1] === 'wrong-private-paste') throw new Error('CAPTCHA_RETURN_INVALID');
        return host.publish({step:'verification-code',kind:'email',identifier:'person@example.invalid'});
      }
    });
    const screen = await mount(host.client);await screen.press('\r');
    await screen.press('wrong-private-paste');await screen.press('\r');
    expect(screen.all()).toContain('verification address is not valid');
    const returned = `${challenge.url}#cindy-captcha=ok.fictional-private-token`;
    await screen.press(returned);
    expect(screen.all()).not.toContain('fictional-private-token');expect(screen.all()).not.toContain('wrong-private-paste');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:captcha-complete',[challenge.id,returned]);
    expect(screen.latest()).toContain('Verification code');
  });

  it('offers enterprise discovery directly, then follows realm confirmation and SSO',async()=>{
    const host = fakeClient(null);
    const method = {type:'sso' as const,connectionId:'fictional-connection',connectionName:'Example enterprise',orgName:'Example organization',protocol:'saml' as const,ssoRequired:false};
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:organization') return host.publish({step:'realm-confirmation',targetRegion:'cn',providers,methods:[method]});
      if (channel === 'terminal:auth:realm') return host.publish({step:'method-choice',email:'',methods:[method]});
      if (channel === 'terminal:auth:authorize') return {started:true};
    });
    const screen = await mount(host.client,{sso:true});
    await screen.press('example-enterprise');await screen.press('\r');
    expect(screen.latest()).toContain('Mainland China');
    await screen.press('\r');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:organization',['example-enterprise']);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:realm',[true]);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:authorize',['sso','fictional-connection']);
  });

  it('routes binding, MFA, and account selection without exposing submitted values',async()=>{
    const host = fakeClient({step:'binding',bindType:'email',codeRequested:false});
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:binding-code') return host.publish({step:'binding',bindType:'email',codeRequested:true,contact:String(args[0])});
      if (channel === 'terminal:auth:binding-verify') return host.publish({step:'sso-verification',channel:'sms',targetMasked:'+1***',codeRequested:false});
      if (channel === 'terminal:auth:sso-verify') return host.publish({step:'account-selection',accounts:[membership]});
      if (channel === 'terminal:auth:select') return host.publish({step:'completed',membership},true);
    });
    const screen = await mount(host.client);
    await screen.press('\r');await screen.press('person@example.invalid');await screen.press('\r');
    await screen.press('\r');await screen.press('fictional-binding-code');await screen.press('\r');
    await screen.press('\r');await screen.press('fictional-mfa-code');await screen.press('\r');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:select',['fictional-member']);
    expect(screen.all()).not.toContain('fictional-binding-code');expect(screen.all()).not.toContain('fictional-mfa-code');
  });

  it('routes a locked vault to its settings without starting login',async()=>{
    const host = fakeClient(null,true);const screen = await mount(host.client);
    expect(screen.all()).toContain('Unlock your credentials');
    await screen.press('\r');expect(screen.onNeedsVault).toHaveBeenCalledOnce();
    expect(vi.mocked(host.client.invoke).mock.calls.map(call=>call[0])).toEqual(['terminal:status']);
  });

  it('does not render raw failures and can cancel while a protected input is pending',async()=>{
    const host = fakeClient({step:'verification-code',kind:'email',identifier:'person@example.invalid'});
    let stalled = false;
    host.handle(channel=>{
      if (channel === 'terminal:auth:verify') {
        if (stalled) return new Promise(()=>{});
        throw new Error('fictional-private-provider-error');
      }
    });
    const screen = await mount(host.client);
    await screen.press('\r');await screen.press('fictional-first-code');await screen.press('\r');
    expect(screen.all()).toContain('Sign-in could not be completed');
    expect(screen.all()).not.toContain('fictional-private-provider-error');
    stalled = true;
    await screen.press('fictional-second-code');await screen.press('\r');
    // Kitty's explicit Escape avoids the parser's ambiguous ESC-prefix delay.
    await screen.press('\x1b[27u');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:cancel',[]);
    expect(screen.latest()).toContain('Google');
    expect(screen.all()).not.toContain('fictional-second-code');
  });

  it('loads available memberships, switches locally, and signs out',async()=>{
    const host = fakeClient();host.publish({step:'completed',membership},true);
    host.handle(channel=>{
      if (channel === 'terminal:auth:memberships') return [{...membership,id:'second-membership',displayName:'Second account',orgSlug:null}];
      if (channel === 'terminal:auth:membership') return host.publish({step:'completed',membership},true);
      if (channel === 'terminal:auth:logout') return host.publish(initialFlow);
    });
    const screen = await mount(host.client);
    await screen.press('\x1b[B');await screen.press('\r');
    expect(screen.latest()).toContain('Second account');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:membership',['second-membership']);
    await screen.press('\x1b[B');await screen.press('\x1b[B');await screen.press('\x1b[B');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:logout',[]);
    expect(vi.mocked(host.client.invoke).mock.calls.every(call=>call[2] === undefined)).toBe(true);
  });
});


// The production resource controller must retain server form defaults and its
// revision token. Deletion must leave the stale detail screen (unit tier).
it('edits resource defaults and returns to the collection after deletion',async()=>{
  const host=fakeClient();let removed=false;let submitted:unknown;
  const ref={collectionId:'fixture',kind:'fixture',id:'one'};
  const collection={id:'fixture',resourceKind:'fixture',title:'Records'};
  const item={ref,revision:'1',links:[],display:{title:'Saved record'}};
  host.handle((channel,args)=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[collection]};
    if(channel==='maker:remote-resources:list')return {collectionId:'fixture',items:removed?[]:[item]};
    if(channel==='maker:remote-resources:get')return {...item,actions:[
      {id:'edit',label:'Edit',fields:[{id:'title',label:'Title',kind:'text',required:true},{id:'mode',label:'Mode',kind:'select',options:[{value:'a',label:'A'},{value:'b',label:'B'}]},{id:'enabled',label:'Enabled',kind:'toggle'}]},
      {id:'delete',label:'Delete',confirmation:{title:'Delete record?',confirmLabel:'Delete'}},
    ],blocks:[{id:'edit',primitive:'form',fallbackMarkdown:'',data:{actionId:'edit',values:{title:'Existing title',mode:'b',enabled:true,__revision:'rev-1'}}}]};
    if(channel==='maker:remote-resources:invoke'){
      const request=args[0] as {actionId:string;input:unknown};
      if(request.actionId==='edit')submitted=request.input;else removed=true;
      return {effects:[{kind:'refresh-collection',collectionId:'fixture'}]};
    }
  });
  const screen=await mount(host.client,{node:<Resources client={host.client} locale="en" initialCollection="fixture" onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('\r');
  expect(screen.latest()).toContain('Existing title');
  await screen.press('\r');await screen.press('\r');await screen.press('\r');
  expect(submitted).toEqual({title:'Existing title',mode:'b',enabled:true,__revision:'rev-1'});
  expect(screen.latest()).toContain('Records');
  await screen.press('\r');await screen.burst(['\x1b[B','\r']);
  await screen.press('\r');expect(removed).toBe(false);
  await screen.burst(['\x1b[B','\r']);await screen.burst(['\x1b[B','\r']);
  expect(removed).toBe(true);expect(screen.latest()).toContain('Records');expect(screen.latest()).not.toContain('Saved record');
});
