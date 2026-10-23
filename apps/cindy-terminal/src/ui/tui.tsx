import { PluginSetupView } from './plugin-setup.js';
import type { GhostSetupInteractionSnapshot } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
import { ProtectedInputView } from './protected-input.js';
import { inputHandoffPresentation, INPUT_HANDOFF_LOCAL_CHANNEL, INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL, type InputHandoffSnapshot } from '@cindy/device-link';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setDefaultModel, enqueueMessage, connectedModels } from '../client-operations.js';
import type { TerminalClient } from '../contracts.js';
import type { TerminalAuthSnapshot } from '@cindy/auth-client';
import type { InteractionRequest } from '@cindy/maker-core';
import { InteractionView } from './interaction.js';
import { Authentication } from './authentication.js';
import { Resources } from './resources.js';
import { getMessages, getControlMessages, getModelMessages, getServiceMessages, type Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';

export type TuiExternalAction={type:'native-auth';kind:'pi'|'codex'|'claude-code';operation:'login'|'logout'} | {type:'service-uninstall'} | {type:'service-activate'} | {type:'service-boot'};
type Row = { id: string; title: string; detail?: string; run: () => void | Promise<void> };
type Field = { key: string; label: string; secret?: boolean; value?: string; optional?: boolean; choices?: string[] };
type Form = { id: number; title: string; fields: Field[]; submit: (values: Record<string, string>) => Promise<void> };
type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): Data[] => Array.isArray(value) ? value.map(record) : [];
const label = (value: unknown, fallback = '') => typeof value === 'string' ? terminalText(value) : fallback;
function unwrap(value: unknown): unknown {
  const data = record(value);
  if (data.ok === false) throw new Error(label(record(data.error).code,label(data.code,'OPERATION_FAILED')));
  return data.ok === true && 'data' in data ? data.data : value;
}

function FormView({ form, submit, cancel, busy, error }: { form: Form; submit: (values: Record<string,string>) => void; cancel: () => void; busy: boolean; error: string }) {
  const {rows}=useWindowSize();
  const [values, setValues, valuesNow] = useInputState<Record<string, string>>(Object.fromEntries(form.fields.map(f => [f.key, f.value ?? f.choices?.[0] ?? ''])));
  const [fieldIndex, setFieldIndex, indexNow] = useInputState(0);
  const [query,setQuery,queryNow]=useInputState('');
  const field = form.fields[fieldIndex];
  useInput((input, key) => {
    if(key.eventType==='release')return;
    const field=form.fields[indexNow.current];
    if (key.tab) {setQuery('');setFieldIndex(index => (index + (key.shift ? form.fields.length - 1 : 1)) % form.fields.length);}
    if(field.choices){
      if(key.escape){if(queryNow.current)setQuery('');else cancel();return;}
      if(key.return)next();
      const choices=field.choices.filter(choice=>choice.toLocaleLowerCase().includes(queryNow.current.toLocaleLowerCase()));
      if(choices.length&&(key.upArrow||key.downArrow)){const at=choices.indexOf(valuesNow.current[field.key]);const nextIndex=(at+(key.upArrow?choices.length-1:1))%choices.length;setValues(current=>({...current,[field.key]:choices[nextIndex]}));}
      if(key.backspace||!key.ctrl&&!key.meta&&!key.tab&&!key.return&&!key.upArrow&&!key.downArrow&&input){
        const next=key.backspace?queryNow.current.slice(0,-1):queryNow.current+terminalText(input);
        setQuery(next);const match=field.choices.find(choice=>choice.toLocaleLowerCase().includes(next.toLocaleLowerCase()));
        setValues(current=>({...current,[field.key]:match??''}));
      }
    }
  }, { isActive: !busy });
  function next() {
    const field=form.fields[indexNow.current];
    if (!valuesNow.current[field.key].trim() && !field.optional) return;
    if (indexNow.current < form.fields.length - 1) {setQuery('');setFieldIndex(indexNow.current + 1);}
    else submit(valuesNow.current);
  }
  const choices=field.choices?.filter(choice=>choice.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const choiceIndex=choices?.indexOf(values[field.key])??0;
  const choiceStart=Math.max(0,choiceIndex-Math.max(3,rows-14)+1);
  return <Box flexDirection="column" paddingY={1} gap={1}>
    <Text bold>{form.title}</Text>
    <Text dimColor>{fieldIndex+1} / {form.fields.length}</Text>
    <Text>{field.label}</Text>
    {query&&<Text dimColor>/ {query}</Text>}
    {choices?<Box flexDirection="column">{choices.slice(choiceStart,choiceStart+Math.max(3,rows-14)).map(choice=><Text key={choice} wrap="truncate-end" bold={values[field.key]===choice}>{values[field.key]===choice?'› ':'  '}{choice}</Text>)}</Box>
      :<Input key={field.key} value={values[field.key]} secret={field.secret} active={!busy} onChange={value=>setValues(current=>({...current,[field.key]:value}))} onSubmit={next} onCancel={cancel} />}
    {error && <Text color="red">{error}</Text>}
  </Box>;
}

function TerminalApp({ client, locale: initialLocale, initialPage, initialTask, initialDevice, initialSso, initialCollection, onExternalAction }: {
  client: TerminalClient; locale: Locale; initialPage?: string; initialTask?: string; initialDevice?: string; initialSso?: boolean;initialCollection?:string; onExternalAction(action:TuiExternalAction):void;
}) {
  const [locale, setLocale] = useState(initialLocale);
  const t = getMessages(locale);
  const controls=getControlMessages(locale);
  const modelText=getModelMessages(locale);
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [page, setPage] = useState(initialPage ?? 'tasks');
  const [engine,setEngine]=useState<'pi'|'codex'|'claude-code'>('codex');
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected, selectedNow] = useInputState(0);
  const [filter,setFilter]=useState('');
  const [form, setForm] = useState<Form | null>(null);
  const formGeneration=useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Data>({});
  const [auth, setAuth] = useState<TerminalAuthSnapshot | null>(null);
  const [pluginAuthorization,setPluginAuthorization]=useState<{url:string;userCode?:string}>();
  const [resourceTarget,setResourceTarget]=useState<import('@cindy/device-link').RemoteResourceRef>();
  const [pending, setPending] = useState<Array<InteractionRequest|InputHandoffSnapshot|GhostSetupInteractionSnapshot>>([]);
  const [reviewRequest, setReviewRequest] = useState(false);
  const [running, setRunning] = useState(false);
  const [device, setDevice] = useState(initialDevice);
  const [deviceLabel,setDeviceLabel]=useState('');
  const [targetOnline,setTargetOnline]=useState(true);
  const [task, setTask] = useState(initialTask);
  const [messages, setMessages] = useState<Data[]>([]);
  const [historyExhausted,setHistoryExhausted]=useState(false);
  const loadingOlder=useRef(false);
  const [taskInfo,setTaskInfo]=useState<Data>({});
  const [draft, setDraft] = useState('');
  const [attachments,setAttachments]=useState<Array<{path:string;name:string}>>([]);
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
  const navigate = (target: string) => { setPage(target); setItems([]); setSelected(0);setFilter(''); setForm(null); setError(''); setTask(undefined); setScroll(0);setAttachments([]); };
  function edit(title: string, fields: Field[], submit: Form['submit']) { setError(''); setForm({ id:++formGeneration.current,title,fields,submit }); }
  async function newTask() {
    const models=await connectedModels(client,device);
    if(!models.length)throw new Error('MODEL_NOT_CONFIGURED');
    edit(t.newTask, [{ key:'title', label:t.newTask, optional:true }, {key:'model',label:t.models,choices:models.map(item=>item.label)}, { key:'workingDir', label:t.directory, optional:true, value:device?'':label(record(latestStatus.current.settings).workingDir) }], async values => {
      const selection=models.find(item=>item.label===values.model);
      if(!selection)throw new Error('MODEL_NOT_CONFIGURED');
      const value = record(await call('maker:create-session', [{ ...selection, title: values.title || t.newTask, ...(values.workingDir?{workingDir:values.workingDir}:{workspaceKind:'dialogue'}) }]));
      const id = label(value.sessionId, label(value.id));
      if (!id) throw new Error('INVALID_SESSION_RESPONSE');
      setForm(null); setTask(id); setPage('tasks'); setDraft('');
    });
  }
  async function taskCommands(){
    if(!task)return;
    const taskId=task;
    const kind=taskInfo.agentKind==='cc'?'claude-code':label(taskInfo.agentKind);
    const providers=await call('maker:provider:list');
    const provider=array(record(providers).providers??providers).find(item=>item.id===(taskInfo.providerId??taskInfo.provider_id));
    const model=array(record(provider?.models)[kind]).find(item=>item.id===taskInfo.model);
    const choices=[t.models,controls.permission,controls.plan,controls.compact,controls.attach,...(attachments.length?[controls.removeAttachments]:[]),...(Array.isArray(model?.efforts)&&model.efforts.length?[controls.effort]:[]),...(model?.supportsFastMode?[controls.fast]:[]),...(pending.length?[t.requests]:[]),t.stop];
    edit(t.commands,[{key:'action',label:t.commands,choices}],async values=>{
      const chosen=values.action;
      if(chosen===controls.attach){edit(controls.attach,[{key:'path',label:controls.filePath}],async value=>{const file=path.resolve(value.path);setAttachments(items=>[...items,{path:file,name:path.basename(file)}]);setForm(null);});return;}
      if(chosen===controls.removeAttachments){setAttachments([]);setForm(null);return;}
      if(chosen===t.requests){setForm(null);setReviewRequest(true);return;}
      if(chosen===t.stop){await call('maker:abort-session',[taskId]);setForm(null);return;}
      if(chosen===controls.compact){await call('maker:compact-session',[taskId]);setForm(null);await load();return;}
      if(chosen===t.models){
        const models=(await connectedModels(client,device)).filter(item=>item.agentKind===kind);
        edit(t.models,[{key:'model',label:t.models,choices:models.map(item=>item.label)}],async values=>{const selection=models.find(item=>item.label===values.model);if(!selection)throw new Error('MODEL_NOT_CONFIGURED');await call('maker:set-model',[taskId,selection.model,{providerId:selection.providerId}]);setForm(null);await load();});return;
      }
      const fieldChoices=chosen===controls.permission?['ask','auto','bypassPermissions']:chosen===controls.effort?(model!.efforts as string[]):[controls.off,controls.on];
      edit(chosen,[{key:'value',label:chosen,choices:fieldChoices}],async values=>{
        const channel=chosen===controls.permission?'maker:set-permission-mode':chosen===controls.effort?'maker:set-effort':chosen===controls.plan?'maker:set-plan-mode':'maker:set-fast-mode';
        await call(channel,[taskId,chosen===controls.permission||chosen===controls.effort?values.value:values.value===controls.on]);setForm(null);await load();
      });
    });
  }
  async function addProvider() {
    if(device)throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    const presets=array(record(await call('maker:provider:presets',[],false)).presets);
    const names=presets.map(p=>`${label(locale==='zh-TW'?p.nameZhTW:locale.startsWith('zh')?p.name:p.nameEn,label(p.name))} · ${label(p.id)}`);
    edit(t.addProvider,[{key:'source',label:modelText.source,choices:[modelText.custom,...names]}],async values=>{
      const preset=presets[names.indexOf(values.source)];
      if(!preset){providerForm();return;}
      const runtimes=record(preset.runtimes);
      edit(t.engine,[{key:'engine',label:t.engine,choices:Object.keys(runtimes)}],async values=>providerForm(undefined,values.engine,record(runtimes[values.engine]),label(preset.name),record(preset).authMethod==='none'?'none':'apiKey'));
    });
  }
  function providerForm(existing?:Data, selectedEngine?:string, template:Data={}, suggestedName='', authMethod='apiKey') {
    const existingRuntimes=record(existing?.runtimes);
    const chosenEngine=selectedEngine??Object.keys(existingRuntimes)[0]??'pi';
    const runtime=existing?record(existingRuntimes[chosenEngine]):template;
    edit(existing?modelText.edit:t.addProvider, [
      {key:'name',label:t.providerName,value:label(existing?.name,suggestedName)},
      {key:'engine',label:t.engine,choices:selectedEngine?[selectedEngine]:['pi','codex','claude-code'],value:chosenEngine},
      {key:'protocol',label:t.protocol,choices:['openai-chat','openai-responses','anthropic-messages'],value:label(runtime.wireProtocol,chosenEngine==='codex'?'openai-responses':chosenEngine==='claude-code'?'anthropic-messages':'openai-chat')},
      {key:'baseUrl',label:t.address,value:label(runtime.baseUrl)},
      ...(!existing?[{key:'model',label:t.modelId,value:label(array(runtime.models)[0]?.id)}]:[]),
      {key:'auth',label:modelText.auth,choices:[modelText.apiKey,modelText.none],value:(existing?record(existing.auth).method:authMethod)==='none'?modelText.none:modelText.apiKey},
      {key:'apiKey',label:existing?modelText.keepKey:t.apiKey,secret:true,optional:true},
      {key:'headers',label:modelText.headers,secret:true,optional:true},
    ],async values=>{
      const providerId=label(existing?.id,`custom-${randomUUID()}`);
      const agentKind=values.engine;
      let headers:unknown;
      if(values.headers){try{headers=JSON.parse(values.headers);}catch{throw new Error('INVALID_PROVIDER_HEADER');}}
      const models=existing?array(runtime.models):array(template.models).some(m=>m.id===values.model)?array(template.models):[{id:values.model,name:values.model}];
      await call(existing?'maker:provider:custom:update':'maker:provider:custom:create',[{
        ...existing,id:providerId,name:values.name,auth:{method:values.auth===modelText.none?'none':'apiKey'},
        runtimes:{...existingRuntimes,[agentKind]:{...runtime,baseUrl:values.baseUrl,wireProtocol:values.protocol,models,...(headers===undefined?{}:{headers})}},
      },values.apiKey?{[agentKind]:values.apiKey}:{}],false);
      if(!existing)await setDefaultModel(client,{providerId,agentKind,model:values.model});
      setForm(null);await load();
    });
  }
  async function manageProvider(provider:Data){
    const id=label(provider.id);
    const custom=array(record(await call('terminal:models:get',[],false)).providers).find(p=>p.id===id);
    const common=[provider.suspended?modelText.enable:modelText.disable,modelText.reset];
    const options=custom?[modelText.edit,modelText.discover,modelText.test,modelText.addModel,modelText.configure,modelText.disconnect,modelText.remove,...common]:[t.refresh,...common];
    edit(label(provider.name,id),[{key:'action',label:t.commands,choices:options}],async values=>{
      const selected=values.action;
      if(common.includes(selected)){await call('maker:model-disable:set',[{providerId:id,kind:selected===modelText.reset?'reset':'provider',disabled:selected===modelText.disable}],false);setForm(null);await load();return;}
      if(selected===t.refresh){await call('maker:provider:models-refresh',[id],false);setForm(null);await load();return;}
      if(!custom)throw new Error('PROVIDER_NOT_FOUND');
      if(selected===modelText.disconnect||selected===modelText.remove){
        edit(selected,[{key:'confirm',label:label(custom.name,id),choices:[t.cancel,t.yes]}],async value=>{if(value.confirm===t.yes)await call(selected===modelText.remove?'maker:provider:custom:delete':'maker:provider:custom:disconnect',[id],false);setForm(null);await load();});return;
      }
      const runtimes=record(custom.runtimes);
      edit(selected,[{key:'engine',label:t.engine,choices:Object.keys(runtimes)}],async value=>{
        const kind=value.engine,runtime=record(runtimes[kind]);
        if(selected===modelText.edit){providerForm(custom,kind);return;}
        if(selected===modelText.test){
          const result=record(await call('maker:provider:test-connection',[{kind:'saved',agent:kind,providerId:id}],false));
          if(result.ok===false)throw new Error(label(result.code,'PROVIDER_TEST_FAILED'));
          edit(modelText.testPassed,[{key:'done',label:`${result.latencyMs} ms`,choices:[t.done]}],async()=>setForm(null));return;
        }
        if(selected===modelText.discover){
          const result=record(await call('maker:provider:models-fetch',[{agent:kind,baseUrl:runtime.baseUrl,authMethod:record(custom.auth).method,wireProtocol:runtime.wireProtocol,savedProviderId:id}],false));
          const found=array(result.models);if(!found.length)throw new Error('NO_MODELS_DISCOVERED');
          edit(modelText.addModel,[{key:'model',label:t.modelId,choices:found.map(m=>label(m.id))}],async values=>{await saveModel(found.find(m=>m.id===values.model)!);});return;
        }
        if(selected===modelText.configure){
          edit(modelText.configure,[{key:'model',label:t.modelId,choices:array(runtime.models).map(m=>label(m.id))}],async values=>{
            const model=array(runtime.models).find(m=>m.id===values.model)!;
            const view=array(record(provider.models)[kind]).find(m=>m.id===model.id);
            edit(label(model.name,label(model.id)),[{key:'action',label:t.commands,choices:[modelText.edit,view?.disabled?modelText.enable:modelText.disable]}],async selected=>{
              if(selected.action!==modelText.edit){await call('maker:model-disable:set',[{providerId:id,kind:'model',modelIds:[model.id],disabled:selected.action===modelText.disable}],false);setForm(null);await load();return;}
              modelForm(model);
            });
          });return;
        }
        modelForm();
        function modelForm(model?:Data){
          edit(modelText.configure,[{key:'id',label:t.modelId,value:label(model?.id)},{key:'name',label:modelText.modelName,value:label(model?.name),optional:true},{key:'context',label:modelText.context,value:model?.contextWindow===undefined?'':String(model.contextWindow),optional:true}],async values=>{
            const context=values.context?Number(values.context):undefined;
            if(context!==undefined&&(!Number.isSafeInteger(context)||context<1))throw new Error('INVALID_CONTEXT_WINDOW');
            const next:Data={...model,id:values.id,name:values.name||values.id};delete next.contextWindow;
            await saveModel({...next,...(context===undefined?{}:{contextWindow:context})},model?.id);
          });
        }
        async function saveModel(model:Data,previousId?:unknown){
          await call('maker:provider:custom:update',[{...custom,runtimes:{...runtimes,[kind]:{...runtime,models:[...array(runtime.models).filter(m=>m.id!==model.id&&m.id!==previousId),model]}}}],false);
          setForm(null);await load();
        }
      });
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
          const latest=array(record(history).messages ?? history).reverse();
          setMessages(previous=>{
            const ids=new Set(latest.map(item=>item.id));
            const overlap=previous.findIndex(item=>ids.has(item.id));
            return overlap<0?latest:[...previous.slice(0,overlap),...latest];
          });
          if(latest.length<200)setHistoryExhausted(true);
          setPending(array(requests).map(value => (value.request ?? value) as InteractionRequest|InputHandoffSnapshot|GhostSetupInteractionSnapshot));
          setRunning(inTurn === true);setTaskInfo(info);
          if(at.device)setTargetOnline(true);
        }
        return;
      }
      let nextItems: Row[] = [];
      if (at.page === 'tasks') {
        const tasks = await call('local-db:sessions:list', [100, 'active']);
        nextItems = [{ id:'new',title:`+ ${t.newTask}`,run:newTask }, ...array(record(tasks).sessions ?? tasks).map(item => ({ id:label(item.id), title:label(item.title,t.newTask),detail:label(item.model),run:() => { setTask(label(item.id)); setScroll(0); } }))];
      } else if (at.page === 'models') {
        const raw = await call('maker:provider:list');
        const preference=at.device?record(await call('terminal:models:target-default',[at.device],false)):record(record(await call('terminal:models:get',[],false)).defaultSelection);
        nextItems = [];
        if(!device)nextItems.push({ id:'add',title:`+ ${t.addProvider}`,run:addProvider },{id:'manage',title:modelText.manage,run:()=>navigate('providers')},{id:'engines',title:t.engines,run:()=>navigate('engines')});
        for (const provider of array(record(raw).providers ?? raw)) {
          if (!provider.connected||provider.suspended) continue;
          for (const [agentKind, models] of Object.entries(record(provider.models))) for (const model of array(models)) {
            if(model.disabled)continue;
            const current=preference.providerId===provider.id&&preference.agentKind===agentKind&&preference.model===model.id;
            const entry:Row={ id:`${provider.id}:${agentKind}:${model.id}`, title:label(model.name,label(model.id)), detail:`${label(provider.name,label(provider.id))} · ${agentKind}${current?` · ${t.defaultModel}`:''}`,run:async () => {
              await setDefaultModel(client,{providerId:label(provider.id),agentKind,model:label(model.id)},device); await load();
            } };
            if(current)nextItems.splice(device?0:3,0,entry);else nextItems.push(entry);
          }
        }
      } else if(at.page==='providers'){
        const raw=await call('maker:provider:list',[],false);
        nextItems=array(record(raw).providers??raw).filter(p=>p.source==='user'||p.connected).map(provider=>({id:label(provider.id),title:label(provider.name,label(provider.id)),detail:provider.suspended?modelText.disable:provider.connected?t.connected:t.signedOut,run:()=>manageProvider(provider)}));
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
        const serviceText=getServiceMessages(locale);
        const serviceState=record(await call('terminal:service:inspect',[],false));
        const vault = record(nextStatus.vault);
        if (!vault.initialized) nextItems.push({id:'machine',title:t.machineKey,detail:t.vaultExplanation,run:() => vaultForm('machine')}, {id:'passphrase',title:t.passphraseKey,run:() => vaultForm('passphrase')});
        else if (vault.locked) nextItems.push({id:'unlock',title:t.unlock,run:() => edit(t.unlock,[{key:'passphrase',label:t.passphrase,secret:true}],async values => {await call('terminal:vault:unlock',[values.passphrase],false);setForm(null);await load();})});
        nextItems.push({id:'login',title:nextAuth?.session ? t.accounts : t.login,run:() => navigate('login')},
          {id:'resources',title:t.resources,run:()=>navigate('resources')},
          {id:'remote',title:`${record(nextStatus.settings).remoteEnabled ? '[x]' : '[ ]'} ${t.remoteEnabled}`,run:async () => {await call('terminal:settings:update',[{remoteEnabled:!record(nextStatus.settings).remoteEnabled}],false);await load();}},
          {id:'name',title:t.deviceName,detail:label(nextStatus.deviceName),run:()=>edit(t.deviceName,[{key:'deviceName',label:t.deviceName,value:label(nextStatus.deviceName)}],async values=>{await call('terminal:settings:update',[values],false);setForm(null);await load();})},
          {id:'directory',title:t.directory,detail:label(record(nextStatus.settings).workingDir),run:()=>edit(t.directory,[{key:'workingDir',label:t.directory,value:label(record(nextStatus.settings).workingDir)}],async values=>{await call('terminal:settings:update',[values],false);setForm(null);await load();})},
          {id:'language',title:t.language,detail:locale,run:()=>edit(t.language,[{key:'language',label:t.language,value:locale,choices:['en','zh-CN','zh-TW','ja','ko']}],async values=>{await call('terminal:settings:update',[values],false);setLocale(values.language as Locale);setForm(null);await load();})},
          {id:'service',title:nextStatus.installation?t.uninstallService:t.installService,detail:nextStatus.installation?(record(nextStatus.installation).starts==='boot'?t.startsAtBoot:t.startsAtLogin):undefined,run:async () => {
            const result=record(await call(nextStatus.installation?'terminal:service:uninstall':'terminal:service:install',[],false));
            if(result.requiresLocalCompletion){onExternalAction({type:'service-uninstall'});exit();}else await load();
          }});
        if(nextStatus.installation)nextItems.push({id:'activate',title:serviceState.running?serviceText.running:serviceText.activate,detail:serviceState.running?String(serviceState.pid??''):undefined,run:()=>{if(!serviceState.running){onExternalAction({type:'service-activate'});exit();}}});
        if(serviceState.starts!=='boot')nextItems.push({id:'boot',title:serviceText.boot,run:()=>{onExternalAction({type:'service-boot'});exit();}});
      }
      if (at.page === current.current.page && at.device === current.current.device) { setItems(nextItems); setSelected(index => Math.min(index,Math.max(0,nextItems.length-1)));if(at.device&&['tasks','models'].includes(at.page))setTargetOnline(true); }
    } finally {
      loading.current = false;
      if (reload.current) { reload.current = false; queueMicrotask(()=>void loadCurrent.current().catch(()=>{})); }
    }
  }
  loadCurrent.current = load;

  async function olderHistory(){
    if(!task||historyExhausted||loadingOlder.current||!messages[0])return;
    const at={task,device};loadingOlder.current=true;
    try{
      const value=await call('local-db:messages:list',[task,{limit:200,before:messages[0].id}]);
      if(current.current.task!==at.task||current.current.device!==at.device)return;
      const older=array(record(value).messages??value).reverse();
      setHistoryExhausted(older.length<200);
      setMessages(previous=>{const ids=new Set(previous.map(item=>item.id));return [...older.filter(item=>!ids.has(item.id)),...previous];});
    }finally{loadingOlder.current=false;}
  }

  useEffect(()=>{setMessages([]);setHistoryExhausted(false);setScroll(0);},[task,device]);
  useEffect(()=>{setResourceTarget(undefined);},[device]);
  useEffect(() => { void action(load); }, [page,task,device]);
  useEffect(()=>{
    setDeviceLabel('');setTargetOnline(!device);if(!device)return;
    let active=true;
    void client.invoke('terminal:devices:list').then(value=>{const target=array(value).find(item=>item.deviceId===device);if(active){setDeviceLabel(label(target?.name,label(target?.deviceName)));if(target)setTargetOnline(target.online===true);}}).catch(()=>{});
    return()=>{active=false;};
  },[client,device]);
  useEffect(() => { if (!pending.length) setReviewRequest(false); }, [pending.length]);
  useEffect(() => client.subscribe((channel,args) => {
    const navigatePlugin=(payload:unknown)=>{const value=record(payload);if(value.sessionId!==current.current.task)return;if(value.target==='client_settings'){setPage('models');return;}if(value.target==='plugin_settings'&&typeof value.ghostId==='string'){setResourceTarget({collectionId:'plugins',kind:'plugin',id:value.ghostId});setPage('resources');}};
    if(channel==='terminal:plugin-settings'&&!current.current.device){navigatePlugin(args[0]);return;}
    if(channel==='terminal:plugin-authorization'){void client.invoke('terminal:plugin-authorizations',[]).then(result=>{const items=array(unwrap(result));const latest=items[items.length-1];setPluginAuthorization(latest?{url:String(latest.url),...(typeof latest.userCode==='string'?{userCode:latest.userCode}:{})}:undefined);}).catch(()=>{});}
    else if (channel === 'terminal:connection-lost') { setConnected(false);setError(t.connectionLost); }
    else if (channel === 'terminal:connection-ready') {setConnected(true);setError(previous=>previous===t.connectionLost?'':previous);setConnectionEpoch(value=>value+1);void loadCurrent.current().catch(()=>{});}
    else if (channel === 'terminal:remote-status') {if(current.current.device){if(args[0]!=='online')setTargetOnline(false);else void loadCurrent.current().catch(()=>{});}}
    else if (channel === 'terminal:devices:changed') {const changed=record(args[0]);if(changed.deviceId===current.current.device)setTargetOnline(changed.online===true);if(current.current.page==='connections')void loadCurrent.current().catch(()=>{});}
    else if (channel === 'terminal:auth:changed') setAuth(args[0] as TerminalAuthSnapshot);
    else if (channel === 'terminal:remote-event') {
      const push = record(args[0]);
      if(push.deviceId===current.current.device&&push.channel==='terminal:plugin-settings'){navigatePlugin(push.payload);return;}
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
  const visibleItems = filter?items.filter(item=>`${item.title} ${item.detail??''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())):items;
  useInput((input,key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && input === 'q') { client.close();exit();return; }
    if (page === 'login' || form || reviewRequest || busy) return;
    if(!task&&key.ctrl&&input==='p'){
      const pages=['tasks','models','connections','resources','service'] as const;
      edit(t.commands,[{key:'page',label:t.commands,choices:pages.map(page=>t[page])}],async values=>navigate(pages.find(page=>t[page]===values.page)??'tasks'));return;
    }
    if(!task&&page!=='resources'&&(key.ctrl&&input==='f'||input==='/')){edit(t.search,[{key:'query',label:t.search,value:filter,optional:true}],async values=>{setFilter(values.query);setSelected(0);setForm(null);});return;}
    if (key.tab) { const pages=['tasks','models','connections','service']; navigate(pages[(pages.indexOf(page)+(key.shift?pages.length-1:1))%pages.length]);return; }
    if (page === 'resources') return;
    if (key.escape) { if (task) {setTask(undefined);setDraft('');} else if(page==='engine')navigate('engines');else if(page==='engines'||page==='providers')navigate('models');else navigate('tasks'); return; }
    if (task) {
      if(key.ctrl&&input==='p'){void action(taskCommands);return;}
      if ((input === '\u001bOQ' || input === '\u001b[12~') && pending.length) { setReviewRequest(true); return; }
      if (key.ctrl && input === 'r' && pending.length) { setReviewRequest(true); return; }
      if (key.pageUp) {setScroll(value => Math.min(Math.max(0,chatLines.length-chatPageSize),value+8));if(scroll+chatPageSize+16>=chatLines.length)void action(olderHistory);}
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
  const draftRows=Math.min(Math.max(2,Math.min(5,Math.floor(height/4))),wrapAnsi(draft||' ',Math.max(8,columns-2),{hard:true,trim:false}).split('\n').length);
  const chatPageSize = Math.max(3,height-12-draftRows-(attachments.length?1:0));
  const start = Math.max(0,selected-pageSize+1);
  const title = task ? t.history : page === 'login' ? t.login : page==='engine'?engine:page==='engines'?t.engines:page==='providers'?modelText.manage:t[page as 'tasks'];
  const chatLines = messages.filter(message=>['user','assistant','error'].includes(label(message.role))).flatMap(message => {
    const raw=message.content;
    let structured:Data|undefined;
    if(typeof raw==='string'&&raw.startsWith('{')){try{const value=record(JSON.parse(raw));if(typeof value.text==='string')structured=value;}catch{/* Ordinary text remains text. */}}
    const content = structured?[label(structured.text),...[...array(structured.images),...array(structured.files)].map(file=>`[${controls.attachment}] ${label(file.name,label(file.originalName,'…'))}`)].filter(Boolean).join('\n')
      :typeof raw === 'string' ? raw : Array.isArray(raw)?raw.map(part=>label(record(part).text)).filter(Boolean).join('\n'):label(message.text);
    return [...wrapAnsi(terminalText(`${message.role==='user'?t.you:message.role==='assistant'?'Cindy':t.error}  ${content}`),Math.max(8,columns-2),{hard:true,trim:false}).split('\n'), ''];
  });
  return <Box flexDirection="column" width={columns} height={height} paddingX={1}>
    <Box justifyContent="space-between" gap={2}><Text bold>Cindy</Text><Box flexShrink={1}><Text wrap="truncate-end">{device ? deviceLabel||label(device) : label(status.deviceName,t.local)} · {connected && targetOnline ? t.connected : t.offline}</Text></Box></Box>
    <Box gap={columns<65?1:2} flexWrap="wrap" marginTop={1}>{(['tasks','models','connections','service'] as const).map(key => <Text key={key} bold={page === key} underline={page === key}>{t[key]}</Text>)}</Box>
    <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {page === 'login' ? <Authentication client={client} locale={locale} sso={initialSso} onDone={()=>navigate('tasks')} onNeedsVault={()=>navigate('service')} />
        : form ? <FormView key={form.id} form={form} busy={busy} error={error} cancel={() => setForm(null)} submit={values => void action(() => form.submit(values))} />
        : page === 'resources' ? <Resources client={client} device={device} locale={locale} initialCollection={initialCollection} initialRef={resourceTarget} onTask={(id,target)=>{if(target)setDevice(target);setTask(id);setPage('tasks');}} />
        : task && reviewRequest && pending[0]?.kind==='input_handoff' ? <ProtectedInputView key={`${pending[0].requestId}:${pending[0].revision}`} request={pending[0]} locale={locale} busy={busy} back={()=>setReviewRequest(false)}
          submit={submission=>{const request=pending[0] as InputHandoffSnapshot;void action(async()=>{const result=unwrap(await client.invoke(device?INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL:INPUT_HANDOFF_LOCAL_CHANNEL,[device?{deviceId:device,presentation:inputHandoffPresentation(request),submission}:{requestId:request.requestId,submission}]));if(record(result).accepted!==true)throw new Error('INPUT_HANDOFF_STALE');setReviewRequest(false);await load();});}}
          decide={decision=>void action(async()=>{await call('maker:resolve-interaction',[pending[0].requestId,decision]);setReviewRequest(false);await load();})}/>
        : task && reviewRequest && pending[0]?.kind==='plugin_setup' ? <PluginSetupView key={pending[0].requestId} request={pending[0]} locale={locale} busy={busy} authorization={pluginAuthorization} back={()=>setReviewRequest(false)}
          resolve={decision=>{void action(async()=>{await call('maker:resolve-interaction',[pending[0].requestId,decision]);await load();});}}
          submit={submission=>{void action(async()=>{await client.invoke('terminal:plugin-assist',[{...submission,...(device?{deviceId:device}:{})}]);await load();});}}/>
        : task && reviewRequest && pending[0] && pending[0].kind!=='input_handoff' && pending[0].kind!=='plugin_setup' ? <InteractionView key={pending[0].requestId} request={pending[0]} locale={locale} busy={busy} back={()=>setReviewRequest(false)} resolve={decision=>void action(async()=>{ await call('maker:resolve-interaction',[pending[0].requestId,decision]); setReviewRequest(false); await load(); })} />
        : task ? <>
          <Text bold>{label(taskInfo.title,t.newTask)}</Text>
          <Text dimColor>{label(taskInfo.model)} · {label(taskInfo.agentKind)} · {running ? t.working : t.ready}{pending.length ? ` · ${t.requests} ${pending.length} (Ctrl+R)` : ''}</Text>
          <Box flexGrow={1} flexDirection="column" overflow="hidden">{chatLines.slice(Math.max(0,chatLines.length-chatPageSize-scroll), Math.max(0,chatLines.length-scroll)).map((line,index)=><Text key={index}>{terminalText(line)||' '}</Text>)}</Box>
          <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
          {attachments.length>0&&<Text dimColor>{attachments.map(file=>file.name).join(' · ')}</Text>}
          <Input value={draft} onChange={setDraft} active={!busy && connected && !reviewRequest} multiline onCancel={() => {setTask(undefined);setAttachments([]);}} onSubmit={value => {
            if (!value.trim()&&!attachments.length) return;
            void action(async () => { await enqueueMessage(client,task,value,randomUUID(),device,{files:attachments});setDraft('');setAttachments([]);await load(); });
          }} />
          <Text dimColor>{columns<65?`Enter ${t.send} · Alt+Enter ↵ · ^P`:`${t.inputKeys}   Ctrl+P: ${t.commands}`}</Text>
        </> : <>
          <Box marginBottom={1}><Text bold>{title}</Text>{busy && <Text dimColor>  {t.loading}</Text>}</Box>
          {filter&&<Text dimColor>/ {terminalText(filter)}</Text>}
          {visibleItems.slice(start,start+pageSize).map((item,index) => <Box key={item.id} flexDirection="column" marginBottom={item.detail ? 1 : 0}>
            <Text bold={selected === index+start}>{selected === index+start ? '› ' : '  '}{terminalText(item.title)}</Text>
            {item.detail && <Text dimColor>  {terminalText(item.detail)}</Text>}
          </Box>)}
        </>}
    </Box>
    {!form && error && <Text color="red">{error}</Text>}
    <Text dimColor>{'─'.repeat(Math.max(1,columns-2))}</Text>
    <Text dimColor>{columns<65?`↑↓ ${t.choose} · Tab · Esc · ^P · ^Q`:t.keyboard}</Text>
  </Box>;
}

export async function runTui(client: TerminalClient, options: { locale: Locale; page?: string; task?: string; device?: string; sso?: boolean;collection?:string }) {
  let externalAction:TuiExternalAction|undefined;
  const instance = render(<TerminalApp client={client} locale={options.locale} initialPage={options.page} initialTask={options.task} initialDevice={options.device} initialSso={options.sso} initialCollection={options.collection} onExternalAction={action=>{externalAction=action;}} />, {
    // Full-frame updates keep wrapped CJK lines consistent when a terminal shrinks.
    exitOnCtrlC:false, alternateScreen:true, patchConsole:false,
    kittyKeyboard:{ mode:'auto' },
  });
  try { await instance.waitUntilExit(); } finally { instance.cleanup();client.close(); }
  return externalAction;
}
