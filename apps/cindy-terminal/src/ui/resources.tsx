import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type {
  RemoteText, RemoteCollectionDescriptor, RemoteCollectionItem, RemoteResource,
  RemoteResourceRef, RemoteActionDescriptor, RemoteActionInvokeResponse,
} from '@cindy/device-link';
import type { TerminalClient } from '../contracts.js';
import { getMessages, type Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';

/** Portable resource controller; business actions remain on the selected host. */
export function Resources({ client, device, locale, initialCollection, onTask }: { client: TerminalClient; device?: string; locale: Locale;initialCollection?:string; onTask(id: string,device?:string): void }) {
  const t=getMessages(locale);
  const { rows }=useWindowSize();
  const [collections,setCollections]=useState<RemoteCollectionDescriptor[]>([]);
  const [collection,setCollection]=useState<RemoteCollectionDescriptor>();
  const [items,setItems]=useState<RemoteCollectionItem[]>([]);
  const [resource,setResource]=useState<RemoteResource>();
  const [selected,setSelected,selectedNow]=useInputState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [action,setAction]=useState<RemoteActionDescriptor>();
  const [confirmed,setConfirmed]=useState(false);
  const [field,setField]=useState(0);
  const [values,setValues]=useState<Record<string,unknown>>({});
  const [input,setInput]=useState('');
  const [cursor,setCursor]=useState<string>();
  const epoch=useRef(0);
  const descriptor={protocolVersion:1,primitives:['text','actions','session-controls'],locale};
  const txt=(value?:RemoteText)=>terminalText(typeof value==='string'?value:value?.translations?.[locale]??value?.fallback??'');
  async function call<T>(suffix:string,args:Record<string,unknown>):Promise<T>{return client.invoke<T>(`maker:remote-resources:${suffix}`,[{client:descriptor,...args}],device);}
  async function run(work:()=>Promise<void>){setBusy(true);setError('');try{await work();}catch(reason){setError(`${t.error} · ${reason instanceof Error&&/^[A-Z_]+$/.test(reason.message)?reason.message:'RESOURCE_REQUEST_FAILED'}`);}finally{setBusy(false);}}
  async function list(target:RemoteCollectionDescriptor,after?:string){
    const at=epoch.current;
    const result=await call<{items:RemoteCollectionItem[];nextCursor?:string}>('list',{collectionId:target.id,limit:100,...(after?{cursor:after}:{})});
    if(epoch.current!==at)return;
    setCollection(target);setItems(current=>after?[...current,...result.items]:result.items);setCursor(result.nextCursor);setResource(undefined);setSelected(0);
  }
  async function open(ref:RemoteResourceRef){
    const at=epoch.current;
    const result=await call<RemoteResource>('get',{ref});
    if(epoch.current!==at)return;
    setResource(result);setSelected(0);
  }
  async function submit(chosen:RemoteActionDescriptor,inputValues:Record<string,unknown>){
    if(!collection)return;
    const result=await call<RemoteActionInvokeResponse>('invoke',{collectionId:collection.id,actionId:chosen.id,...(resource?{resourceRef:resource.ref}:{}),input:inputValues});
    setAction(undefined);setInput('');setValues({});
    const target=result.result as {sessionId?:unknown;deviceId?:unknown}|undefined;
    if(target&&typeof target.sessionId==='string'&&typeof target.deviceId==='string'){onTask(target.sessionId,target.deviceId);return;}
    for(const effect of result.effects??[]){
      if(effect.kind==='toast')setNotice(txt(effect.message));
      else if(effect.kind==='navigate'){if(effect.target.kind==='session')onTask(effect.target.sessionId);else await open(effect.target.ref);}
      else if(effect.kind==='refresh-resource'&&resource)await open(effect.ref);
      else if(effect.kind==='refresh-collection'&&!resource)await list(collection);
    }
  }
  function begin(chosen:RemoteActionDescriptor){
    if(chosen.disabled)return;
    if(chosen.fields?.some(item=>!['text','multiline','toggle','select'].includes(item.kind))){setError(t.notImplemented);return;}
    setAction(chosen);setConfirmed(!chosen.confirmation);setField(0);setValues({});setInput('');setSelected(0);
    if(!chosen.confirmation&&!chosen.fields?.length)void run(()=>submit(chosen,{}));
  }
  useEffect(()=>{
    epoch.current++;const at=epoch.current;setCollection(undefined);setResource(undefined);setAction(undefined);setSelected(0);
    void run(async()=>{const result=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});if(epoch.current!==at)return;setCollections(result.collections);if(initialCollection){const target=result.collections.find(item=>item.id===initialCollection);if(!target)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');await list(target);}});
    return()=>{epoch.current++;};
  },[device,client]);
  const fieldDescriptor=action?.fields?.[field];
  const choices=action&&!confirmed?[t.cancel,txt(action.confirmation?.confirmLabel)||t.yes]
    :fieldDescriptor?.kind==='toggle'?[t.no,t.yes]
    :fieldDescriptor?.kind==='select'?fieldDescriptor.options?.map(option=>txt(option.label))??[]:[];
  const actions=resource?.actions??collection?.actions??[];
  const links=resource?.links??[];
  const lines=resource?[
    ...links.map(link=>({id:link.rel,title:txt(link.label)||t.history,run:()=>{const target=link.target;return target.kind==='session'?onTask(target.sessionId):void run(()=>open(target.ref));}})),
    ...actions.map(item=>({id:item.id,title:txt(item.label)+(item.disabled?' · —':''),run:()=>begin(item)})),
  ]:collection?[
    ...items.map(item=>({id:item.ref.id,title:txt(item.display.title),run:()=>void run(()=>open(item.ref))})),
    ...actions.map(item=>({id:item.id,title:`+ ${txt(item.label)}`,run:()=>begin(item)})),
    ...(cursor?[{id:'more',title:t.next,run:()=>void run(()=>list(collection,cursor))}]:[]),
  ]:collections.map(item=>({id:item.id,title:txt(item.title),run:()=>void run(()=>list(item))}));
  function nextField(value:unknown){
    if(!action||!fieldDescriptor)return;
    if(fieldDescriptor.required&&(value===undefined||value===''))return;
    const next={...values,[fieldDescriptor.id]:value};
    if(field+1<(action.fields?.length??0)){setValues(next);setField(field+1);setInput('');setSelected(0);}
    else void run(()=>submit(action,next));
  }
  const isText=!!fieldDescriptor&&confirmed&&['text','multiline'].includes(fieldDescriptor.kind);
  useInput((_input,key)=>{
    if(key.eventType==='release')return;
    if(busy||isText)return;
    if(key.escape){epoch.current++;if(action)setAction(undefined);else if(resource)setResource(undefined);else{setCollection(undefined);setItems([]);}setSelected(0);return;}
    const count=action?choices.length:lines.length;
    if(key.upArrow)setSelected(value=>Math.max(0,value-1));
    if(key.downArrow)setSelected(value=>Math.min(count-1,value+1));
    if(key.return){
      if(action&&!confirmed){if(selectedNow.current===0)setAction(undefined);else if(action.fields?.length){setConfirmed(true);setSelected(0);}else void run(()=>submit(action,{}));}
      else if(fieldDescriptor)nextField(fieldDescriptor.kind==='toggle'?selectedNow.current===1:fieldDescriptor.options?.[selectedNow.current]?.value);
      else lines[selectedNow.current]?.run();
    }
  });
  const pageSize=Math.max(3,Math.floor((rows-12)/2));
  const start=Math.max(0,selected-pageSize+1);
  return <Box flexDirection="column" gap={1}>
    <Text bold>{resource?txt(resource.display.title):collection?txt(collection.title):t.resources}{busy?` · ${t.loading}`:''}</Text>
    {resource&&!action&&<Box flexDirection="column" maxHeight={Math.max(3,Math.floor(rows/3))} overflow="hidden">{resource.blocks?.map(block=><Text key={block.id}>{terminalText(block.fallbackMarkdown)}</Text>)}</Box>}
    {action?<>
      <Text>{!confirmed?txt(action.confirmation?.title):fieldDescriptor?txt(fieldDescriptor.label):txt(action.label)}</Text>
      {!confirmed&&action.confirmation?.body&&<Text>{txt(action.confirmation.body)}</Text>}
      {isText?<Input value={input} onChange={setInput} active={!busy} multiline={fieldDescriptor?.kind==='multiline'} onSubmit={nextField} onCancel={()=>setAction(undefined)} />
        :choices.map((choice,index)=><Text key={index} bold={index===selected}>{index===selected?'› ':'  '}{choice}</Text>)}
    </>:lines.slice(start,start+pageSize).map((line,index)=><Text key={line.id} bold={selected===index+start}>{selected===index+start?'› ':'  '}{line.title}</Text>)}
    {notice&&<Text>{notice}</Text>}{error&&<Text color="red">{error}</Text>}
  </Box>;
}
