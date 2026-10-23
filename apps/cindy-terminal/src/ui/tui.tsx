import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { randomUUID } from 'node:crypto';
import { setDefaultModel } from '../client-operations.js';
import type { TerminalClient } from '../contracts.js';
import type { TerminalAuthSnapshot } from '@cindy/auth-client';
import type { InteractionRequest } from '@cindy/maker-core';
import { InteractionView } from './interaction.js';
import { Authentication } from './authentication.js';
import { Resources } from './resources.js';
import { getMessages, type Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';

export type TuiExternalAction={type:'native-auth';kind:'pi'|'codex'|'claude-code';operation:'login'|'logout'} | {type:'service-uninstall'};
type Row = { id: string; title: string; detail?: string; run: () => void | Promise<void> };
type Field = { key: string; label: string; secret?: boolean; value?: string; optional?: boolean; choices?: string[] };
type Form = { title: string; fields: Field[]; submit: (values: Record<string, string>) => Promise<void> };
type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): Data[] => Array.isArray(value) ? value.map(record) : [];
const label = (value: unknown, fallback = '') => typeof value === 'string' ? terminalText(value) : fallback;
function unwrap(value: unknown): unknown {
  const data = record(value);
  if (data.ok === false) throw new Error(label(record(data.error).code, 'OPERATION_FAILED'));
  return data.ok === true && 'data' in data ? data.data : value;
}

function FormView({ form, submit, cancel, busy, error }: { form: Form; submit: (values: Record<string,string>) => void; cancel: () => void; busy: boolean; error: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(form.fields.map(f => [f.key, f.value ?? f.choices?.[0] ?? ''])));
  const [fieldIndex, setFieldIndex] = useState(0);
  const field = form.fields[fieldIndex];
  useInput((_input, key) => {
    if (key.tab) setFieldIndex(index => (index + (key.shift ? form.fields.length - 1 : 1)) % form.fields.length);
    if(field.choices){
      if(key.escape)cancel();
      if(key.return)next();
      if(key.upArrow||key.downArrow){const at=field.choices.indexOf(values[field.key]);const nextIndex=(at+(key.upArrow?field.choices.length-1:1))%field.choices.length;setValues(current=>({...current,[field.key]:field.choices![nextIndex]}));}
    }
  }, { isActive: !busy });
  function next() {
    if (!values[field.key].trim() && !field.optional) return;
    if (fieldIndex < form.fields.length - 1) setFieldIndex(fieldIndex + 1);
    else submit(values);
  }
  return <Box flexDirection="column" paddingY={1} gap={1}>
    <Text bold>{form.title}</Text>
    <Text dimColor>{fieldIndex+1} / {form.fields.length}</Text>
    <Text>{field.label}</Text>
    {field.choices?field.choices.map(choice=><Text key={choice} bold={values[field.key]===choice}>{values[field.key]===choice?'› ':'  '}{choice}</Text>)
      :<Input key={field.key} value={values[field.key]} secret={field.secret} active={!busy} onChange={value=>setValues(current=>({...current,[field.key]:value}))} onSubmit={next} onCancel={cancel} />}
    {error && <Text color="red">{error}</Text>}
  </Box>;
}

function TerminalApp({ client, locale: initialLocale, initialPage, initialTask, initialDevice, initialSso, onExternalAction }: {
  client: TerminalClient; locale: Locale; initialPage?: string; initialTask?: string; initialDevice?: string; initialSso?: boolean; onExternalAction(action:TuiExternalAction):void;
}) {
  const [locale, setLocale] = useState(initialLocale);
  const t = getMessages(locale);
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [page, setPage] = useState(initialPage ?? 'tasks');
  const [engine,setEngine]=useState<'pi'|'codex'|'claude-code'>('codex');
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected, selectedNow] = useInputState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Data>({});
  const [auth, setAuth] = useState<TerminalAuthSnapshot | null>(null);
  const [pending, setPending] = useState<InteractionRequest[]>([]);
  const [reviewRequest, setReviewRequest] = useState(false);
  const [running, setRunning] = useState(false);
  const [device, setDevice] = useState(initialDevice);
  const [task, setTask] = useState(initialTask);
  const [messages, setMessages] = useState<Data[]>([]);
  const [taskInfo,setTaskInfo]=useState<Data>({});
  const [draft, setDraft] = useState('');
  const [scroll, setScroll] = useState(0);
  const [connected, setConnected] = useState(true);
  const [connectionEpoch,setConnectionEpoch] = useState(0);
  const loading = useRef(false);
  const reload = useRef(false);
  const loadCurrent = useRef<() => Promise<void>>(async()=>{});
  const current = useRef({ page, task, device }); current.current = { page, task, device };
  const latestStatus = useRef(status); latestStatus.current = status;

  async function call(channel: string, args: unknown[] = [], remote = true) { return unwrap(await client.invoke(channel, args, remote ? device : undefined)); }
  async function action(work: () => Promise<void>) {
    setError(''); setBusy(true);
    try { await work(); }
    catch (reason) {
      const code = reason instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(reason.message) ? reason.message : 'OPERATION_FAILED';
      setError(`${t.error} · ${code}`);
    } finally { setBusy(false); }
  }
  const navigate = (target: string) => { setPage(target); setItems([]); setSelected(0); setForm(null); setError(''); setTask(undefined); setScroll(0); };
  function edit(title: string, fields: Field[], submit: Form['submit']) { setError(''); setForm({ title, fields, submit }); }
  async function newTask() {
    edit(t.newTask, [{ key:'title', label:t.newTask, optional:true }, { key:'workingDir', label:t.directory, optional:true, value:device?'':label(record(latestStatus.current.settings).workingDir) }], async values => {
      const value = record(await call('maker:create-session', [{ title: values.title || t.newTask, ...(values.workingDir?{workingDir:values.workingDir}:{}) }]));
      const id = label(value.sessionId, label(value.id));
      if (!id) throw new Error('INVALID_SESSION_RESPONSE');
      setForm(null); setTask(id); setPage('tasks'); setDraft('');
    });
  }
  function addProvider() {
    edit(t.addProvider, [
      {key:'name',label:t.providerName},
      {key:'engine',label:t.engine,choices:['pi','codex','claude-code']},
      {key:'protocol',label:t.protocol,choices:['openai-chat','openai-responses','anthropic-messages']},
      {key:'baseUrl',label:t.address},
      {key:'model',label:t.modelId},
      {key:'apiKey',label:t.apiKey,secret:true,optional:true},
    ],async values=>{
      const providerId=`custom-${randomUUID()}`;
      const agentKind=values.engine;
      const wireProtocol=values.protocol;
      await call('maker:provider:custom:create',[{id:providerId,name:values.name,auth:{method:values.apiKey?'apiKey':'none'},runtimes:{[agentKind]:{baseUrl:values.baseUrl,wireProtocol,models:[{id:values.model,name:values.model}]}}},{[agentKind]:values.apiKey}]);
      await setDefaultModel(client,{providerId,agentKind,model:values.model},device);
      setForm(null);await load();
    });
  }
  function vaultForm(mode: 'machine' | 'passphrase') {
    if (mode === 'machine') return action(async () => { await call('terminal:vault:initialize', [mode], false); await load(); });
    edit(t.vaultSetup, [{ key:'passphrase', label:t.passphrase, secret:true }], async values => {
      await call('terminal:vault:initialize', [mode, values.passphrase], false); setForm(null); await load();
    });
  }

  async function load() {
    if (loading.current) { reload.current = true; return; }
    loading.current = true;
    const at = { ...current.current };
    try {
      const nextStatus = record(await call('terminal:status', [], false)); setStatus(nextStatus);
      const nextAuth = nextStatus.auth as TerminalAuthSnapshot | undefined;
      if (record(nextStatus.vault).locked && ['tasks','models','login'].includes(at.page) && !at.device && !at.task) { setPage('service'); return; }
      if (nextAuth) setAuth(nextAuth);
      if (at.task) {
        const history = await call('local-db:messages:list', [at.task, { limit:200 }]);
        const requests = await call('maker:get-pending-interactions', [at.task]);
        const inTurn = await call('maker:session-in-turn', [at.task]);
        const info=record(await call('local-db:sessions:get',[at.task]));
        if (current.current.task === at.task && current.current.device === at.device) {
          setMessages(array(record(history).messages ?? history).reverse());
          setPending(array(requests).map(value => (value.request ?? value) as InteractionRequest));
          setRunning(inTurn === true);setTaskInfo(info);
        }
        return;
      }
      let nextItems: Row[] = [];
      if (at.page === 'tasks') {
        const tasks = await call('local-db:sessions:list', [100, 'active']);
        nextItems = [{ id:'new',title:`+ ${t.newTask}`,run:newTask }, ...array(record(tasks).sessions ?? tasks).map(item => ({ id:label(item.id), title:label(item.title,t.newTask),detail:label(item.model),run:() => { setTask(label(item.id)); setScroll(0); } }))];
      } else if (at.page === 'models') {
        const raw = await call('maker:provider:list');
        nextItems = [{ id:'add',title:`+ ${t.addProvider}`,run:addProvider }];
        if(!device)nextItems.push({id:'engines',title:t.engines,run:()=>navigate('engines')});
        for (const provider of array(record(raw).providers ?? raw)) {
          if (!provider.connected) continue;
          for (const [agentKind, models] of Object.entries(record(provider.models))) for (const model of array(models)) {
            nextItems.push({ id:`${provider.id}:${agentKind}:${model.id}`, title:label(model.name,label(model.id)), detail:`${label(provider.name,label(provider.id))} · ${agentKind}`,run:async () => {
              await setDefaultModel(client,{providerId:label(provider.id),agentKind,model:label(model.id)},device); await load();
            } });
          }
        }
      } else if(at.page==='engines'){
        const statuses=array(await call('terminal:engines:list',[],false));
        nextItems=statuses.map(item=>({id:label(item.kind),title:label(item.kind),detail:label(item.version,t.notInstalled),run:()=>{setEngine(label(item.kind) as typeof engine);navigate('engine');}}));
      } else if(at.page==='engine'){
        const operation=(name:'login'|'logout')=>{onExternalAction({type:'native-auth',kind:engine,operation:name});exit();};
        nextItems=[
          {id:'install',title:t.install,run:async()=>{await call('terminal:engines:install',[engine],false);await load();}},
          {id:'update',title:t.update,run:async()=>{await call('terminal:engines:update',[engine],false);await load();}},
          {id:'login',title:t.providerLogin,run:()=>operation('login')},
          {id:'logout',title:t.signOut,run:()=>operation('logout')},
        ];
      } else if (at.page === 'connections') {
        const devices = await call('terminal:devices:list', [], false);
        nextItems = [{id:'local',title:t.local,run:() => {setDevice(undefined);navigate('tasks');}}, ...array(devices).filter(item=>!item.isSelf).map(item => ({ id:label(item.deviceId),title:label(item.name,label(item.deviceName)),detail:item.online ? t.connected : t.offline,run:async () => {
          await call('terminal:devices:connect',[item.deviceId],false); setDevice(label(item.deviceId)); navigate('tasks');
        } }))];
        if (!nextAuth?.session) nextItems.push({id:'login',title:t.login,run:() => navigate('login')});
      } else if (at.page === 'service') {
        const vault = record(nextStatus.vault);
        if (!vault.initialized) nextItems.push({id:'machine',title:t.machineKey,detail:t.vaultExplanation,run:() => vaultForm('machine')}, {id:'passphrase',title:t.passphraseKey,run:() => vaultForm('passphrase')});
        else if (vault.locked) nextItems.push({id:'unlock',title:t.unlock,run:() => edit(t.unlock,[{key:'passphrase',label:t.passphrase,secret:true}],async values => {await call('terminal:vault:unlock',[values.passphrase],false);setForm(null);await load();})});
        nextItems.push({id:'login',title:nextAuth?.session ? t.accounts : t.login,run:() => navigate('login')},
          {id:'remote',title:`${record(nextStatus.settings).remoteEnabled ? '[x]' : '[ ]'} ${t.remoteEnabled}`,run:async () => {await call('terminal:settings:update',[{remoteEnabled:!record(nextStatus.settings).remoteEnabled}],false);await load();}},
          {id:'name',title:t.deviceName,detail:label(nextStatus.deviceName),run:()=>edit(t.deviceName,[{key:'deviceName',label:t.deviceName,value:label(nextStatus.deviceName)}],async values=>{await call('terminal:settings:update',[values],false);setForm(null);await load();})},
          {id:'directory',title:t.directory,detail:label(record(nextStatus.settings).workingDir),run:()=>edit(t.directory,[{key:'workingDir',label:t.directory,value:label(record(nextStatus.settings).workingDir)}],async values=>{await call('terminal:settings:update',[values],false);setForm(null);await load();})},
          {id:'language',title:t.language,detail:locale,run:()=>edit(t.language,[{key:'language',label:t.language,value:locale,choices:['en','zh-CN','zh-TW','ja','ko']}],async values=>{await call('terminal:settings:update',[values],false);setLocale(values.language as Locale);setForm(null);await load();})},
          {id:'service',title:nextStatus.installation?t.uninstallService:t.installService,detail:nextStatus.installation?(record(nextStatus.installation).starts==='boot'?t.startsAtBoot:t.startsAtLogin):undefined,run:async () => {
            const result=record(await call(nextStatus.installation?'terminal:service:uninstall':'terminal:service:install',[],false));
            if(result.requiresLocalCompletion){onExternalAction({type:'service-uninstall'});exit();}else await load();
          }});
      }
      if (at.page === current.current.page && at.device === current.current.device) { setItems(nextItems); setSelected(index => Math.min(index,Math.max(0,nextItems.length-1))); }
    } finally {
      loading.current = false;
      if (reload.current) { reload.current = false; queueMicrotask(()=>void loadCurrent.current().catch(()=>{})); }
    }
  }
  loadCurrent.current = load;

  useEffect(() => { void action(load); }, [page,task,device]);
  useEffect(() => { if (!pending.length) setReviewRequest(false); }, [pending.length]);
  useEffect(() => client.subscribe((channel,args) => {
    if (channel === 'terminal:connection-lost') { setConnected(false);setError(t.connectionLost); }
    else if (channel === 'terminal:connection-ready') {setConnected(true);setConnectionEpoch(value=>value+1);void loadCurrent.current().catch(()=>{});}
    else if (channel === 'terminal:auth:changed') setAuth(args[0] as TerminalAuthSnapshot);
    else if (channel === 'terminal:remote-event') {
      const push = record(args[0]);
      if (push.deviceId === current.current.device) void loadCurrent.current().catch(() => {});
    } else if (!current.current.device && (channel.includes('event') || channel.includes('changed') || channel.includes('interaction'))) void loadCurrent.current().catch(() => {});
  }), [client,device]);

  useEffect(() => {
    if (!device) return;
    let alive = true; let watch: string | undefined;
    void client.invoke<Data>('terminal:devices:watch',[device,task]).then(value => {
      watch = label(value.id);
      if (!alive && watch) void client.invoke('terminal:devices:unwatch',[watch]).catch(()=>{});
    }).catch(()=>{});
    return () => { alive = false; if (watch) void client.invoke('terminal:devices:unwatch',[watch]).catch(()=>{}); };
  }, [client,device,task,connectionEpoch]);
  const visibleItems = items;
  useInput((input,key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'q') { client.close();exit();return; }
    if (page === 'login' || form || reviewRequest || busy) return;
    if (key.tab) { const pages=['tasks','models','connections','resources','service']; navigate(pages[(pages.indexOf(page)+(key.shift?pages.length-1:1))%pages.length]);return; }
    if (page === 'resources') return;
    if (key.escape) { if (task) {setTask(undefined);setDraft('');} else if(page==='engine')navigate('engines');else if(page==='engines')navigate('models');else navigate('tasks'); return; }
    if (task) {
      if ((input === '\u001bOQ' || input === '\u001b[12~') && pending.length) { setReviewRequest(true); return; }
      if (key.ctrl && input === 'r' && pending.length) { setReviewRequest(true); return; }
      if (key.pageUp) setScroll(value => value+8);
      if (key.pageDown) setScroll(value => Math.max(0,value-8));
      if (key.ctrl && input === 'c') void action(async () => {await call('maker:abort-session',[task]);await load();});
      return;
    }
    if (key.upArrow) setSelected(value => Math.max(0,value-1));
    else if (key.downArrow) setSelected(value => Math.min(visibleItems.length-1,value+1));
    else if (key.return && visibleItems[selectedNow.current]) { const item = visibleItems[selectedNow.current]; void action(async () => {await item.run();}); }
    else if (input === 'r') void action(load);
  });

  const height = Math.max(12,terminalRows);
  const pageSize = Math.max(3,Math.floor((height-10)/3));
  const chatPageSize = Math.max(3,height-14);
  const start = Math.max(0,selected-pageSize+1);
  const title = task ? t.history : page === 'login' ? t.login : page==='engine'?engine:page==='engines'?t.engines:t[page as 'tasks'];
  const chatLines = messages.filter(message=>['user','assistant','error'].includes(label(message.role))).flatMap(message => {
    const raw=message.content;
    const content = typeof raw === 'string' ? raw : Array.isArray(raw)?raw.map(part=>label(record(part).text)).filter(Boolean).join('\n'):label(message.text);
    return [...wrapAnsi(terminalText(`${message.role==='user'?t.you:message.role==='assistant'?'Cindy':t.error}  ${content}`),Math.max(8,columns-2),{hard:true,trim:false}).split('\n'), ''];
  });
  return <Box flexDirection="column" width={columns} height={height} paddingX={1}>
    <Box justifyContent="space-between"><Text bold>Cindy</Text><Text>{device ? label(device) : label(status.deviceName,t.local)} · {connected ? t.connected : t.offline}</Text></Box>
    <Box gap={columns<65?1:2} flexWrap="wrap" marginTop={1}>{(['tasks','models','connections','resources','service'] as const).map(key => <Text key={key} bold={page === key} underline={page === key}>{t[key]}</Text>)}</Box>
    <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {page === 'login' ? <Authentication client={client} locale={locale} sso={initialSso} onDone={()=>navigate('tasks')} onNeedsVault={()=>navigate('service')} />
        : page === 'resources' ? <Resources client={client} device={device} locale={locale} onTask={id=>{setTask(id);setPage('tasks');}} />
        : form ? <FormView key={form.title+form.fields.map(f=>f.key).join()} form={form} busy={busy} error={error} cancel={() => setForm(null)} submit={values => void action(() => form.submit(values))} />
        : task && reviewRequest && pending[0] ? <InteractionView key={pending[0].requestId} request={pending[0]} locale={locale} busy={busy} back={()=>setReviewRequest(false)} resolve={decision=>void action(async()=>{ await call('maker:resolve-interaction',[pending[0].requestId,decision]); setReviewRequest(false); await load(); })} />
        : task ? <>
          <Text bold>{label(taskInfo.title,t.newTask)}</Text>
          <Text dimColor>{label(taskInfo.model)} · {label(taskInfo.agentKind)} · {running ? t.working : t.ready}{pending.length ? ` · ${t.requests} ${pending.length} (Ctrl+R)` : ''}</Text>
          <Box flexGrow={1} flexDirection="column" overflow="hidden">{chatLines.slice(Math.max(0,chatLines.length-chatPageSize-scroll), Math.max(0,chatLines.length-scroll)).map((line,index)=><Text key={index}>{terminalText(line)||' '}</Text>)}</Box>
          <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
          <Input value={draft} onChange={setDraft} active={!busy && connected && !reviewRequest} multiline onCancel={() => setTask(undefined)} onSubmit={value => {
            if (!value.trim()) return;
            void action(async () => { await call('maker:send',[task,{text:value,clientId:randomUUID()}]);setDraft('');await load(); });
          }} />
          <Text dimColor>{t.inputKeys}</Text>
        </> : <>
          <Box marginBottom={1}><Text bold>{title}</Text>{busy && <Text dimColor>  {t.loading}</Text>}</Box>
          {visibleItems.slice(start,start+pageSize).map((item,index) => <Box key={item.id} flexDirection="column" marginBottom={item.detail ? 1 : 0}>
            <Text bold={selected === index+start}>{selected === index+start ? '› ' : '  '}{terminalText(item.title)}</Text>
            {item.detail && <Text dimColor>  {terminalText(item.detail)}</Text>}
          </Box>)}
        </>}
    </Box>
    {!form && error && <Text color="red">{error}</Text>}
    <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
    <Text dimColor>{t.keyboard}</Text>
  </Box>;
}

export async function runTui(client: TerminalClient, options: { locale: Locale; page?: string; task?: string; device?: string; sso?: boolean }) {
  let externalAction:TuiExternalAction|undefined;
  const instance = render(<TerminalApp client={client} locale={options.locale} initialPage={options.page} initialTask={options.task} initialDevice={options.device} initialSso={options.sso} onExternalAction={action=>{externalAction=action;}} />, {
    exitOnCtrlC:false, alternateScreen:true, incrementalRendering:true, patchConsole:false,
    kittyKeyboard:{ mode:'auto' },
  });
  try { await instance.waitUntilExit(); } finally { instance.cleanup();client.close(); }
  return externalAction;
}
