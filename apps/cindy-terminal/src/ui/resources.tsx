import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type {
  RemoteText, RemoteCollectionDescriptor, RemoteCollectionItem, RemoteResource,
  RemoteResourceRef, RemoteActionDescriptor, RemoteActionField, RemoteActionInvokeResponse,
} from '@cindy/device-link';
import type { TerminalClient } from '../contracts.js';
import { getMessages, type Locale } from './i18n.js';
import { Input, terminalText } from './input.js';
import { useInputState } from './state.js';

/** Portable resource controller; business actions remain on the selected host. */
export function Resources({ client, device, locale, initialCollection, initialRef, onTask }: { client: TerminalClient; device?: string; locale: Locale;initialCollection?:string;initialRef?:RemoteResourceRef; onTask(id: string,device?:string): void }) {
  const t=getMessages(locale);
  const { rows, columns }=useWindowSize();
  const [collections,setCollections]=useState<RemoteCollectionDescriptor[]>([]);
  const [collection,setCollection]=useState<RemoteCollectionDescriptor>();
  const [items,setItems]=useState<RemoteCollectionItem[]>([]);
  const [resource,setResource]=useState<RemoteResource>();
  const [selected,setSelected,selectedNow]=useInputState(0);
  const [busy,setBusy,busyNow]=useInputState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [action,setAction,actionNow]=useInputState<RemoteActionDescriptor|undefined>(undefined);
  const [confirmed,setConfirmed,confirmedNow]=useInputState(false);
  const [field,setField,fieldNow]=useInputState(0);
  const [values,setValues,valuesNow]=useInputState<Record<string,unknown>>({});
  const [bodyOffset,setBodyOffset]=useState(0);
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
    if(collection?.id!==ref.collectionId){
      let target=collections.find(item=>item.id===ref.collectionId);
      if(!target){const manifest=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});if(epoch.current!==at)return;setCollections(manifest.collections);target=manifest.collections.find(item=>item.id===ref.collectionId);}
      if(!target)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');
      await list(target);if(epoch.current!==at)return;
    }
    const result=await call<RemoteResource>('get',{ref});
    if(epoch.current!==at)return;
    setResource(result);setSelected(0);setBodyOffset(0);
  }
  async function submit(chosen:RemoteActionDescriptor,inputValues:Record<string,unknown>){
    if(!collection)return;
    const result=await call<RemoteActionInvokeResponse>('invoke',{collectionId:resource?.ref.collectionId??collection.id,actionId:chosen.id,...(resource?{resourceRef:resource.ref}:{}),input:inputValues});
    setAction(undefined);setInput('');setValues({});
    const target=result.result as {sessionId?:unknown;deviceId?:unknown}|undefined;
    if(target&&typeof target.sessionId==='string'&&typeof target.deviceId==='string'){onTask(target.sessionId,target.deviceId);return;}
    for(const effect of result.effects??[]){
      if(effect.kind==='toast')setNotice(txt(effect.message));
      else if(effect.kind==='navigate'){if(effect.target.kind==='session')onTask(effect.target.sessionId);else await open(effect.target.ref);}
      else if(effect.kind==='refresh-resource'&&resource)await open(effect.ref);
      else if(effect.kind==='refresh-collection'&&effect.collectionId===collection.id)await list(collection);
    }
  }
  function begin(chosen:RemoteActionDescriptor){
    if(chosen.disabled)return;
    if(chosen.fields?.some(item=>!['text','multiline','secret','toggle','select'].includes(item.kind))){setError(t.notImplemented);return;}
    const block=resource?.blocks?.find(block=>block.primitive==='form'&&(block.data as {actionId?:string}|undefined)?.actionId===chosen.id);
    const defaults=(block?.data as {values?:Record<string,unknown>}|undefined)?.values??{};
    setAction(chosen);setConfirmed(!chosen.confirmation);setField(0);setValues(defaults);prepareField(chosen.fields?.[0],defaults);if(chosen.confirmation)setSelected(0);
    if(!chosen.confirmation&&!chosen.fields?.length)void run(()=>submit(chosen,{}));
  }
  useEffect(()=>{
    epoch.current++;const at=epoch.current;setCollection(undefined);setResource(undefined);setAction(undefined);setSelected(0);
    void run(async()=>{const result=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});if(epoch.current!==at)return;setCollections(result.collections);const collectionId=initialRef?.collectionId??initialCollection;if(collectionId){const target=result.collections.find(item=>item.id===collectionId);if(!target)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');await list(target);if(initialRef)await open(initialRef);}});
    return()=>{epoch.current++;};
  },[device,client,initialCollection,initialRef]);
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
  function prepareField(next:RemoteActionField|undefined,defaults:Record<string,unknown>){
    const value=next?defaults[next.id]:undefined;
    setInput(typeof value==='string'?value:'');
    setSelected(next?.kind==='toggle'?(value===true?1:0):next?.kind==='select'?Math.max(0,next.options?.findIndex(option=>option.value===value)??0):0);
  }
  function nextField(value:unknown){
    const current=actionNow.current, index=fieldNow.current, descriptor=current?.fields?.[index];
    if(!current||!descriptor)return;
    if(descriptor.required&&(value===undefined||value===''))return;
    const next={...valuesNow.current,[descriptor.id]:value};
    if(index+1<(current.fields?.length??0)){setValues(next);setField(index+1);prepareField(current.fields?.[index+1],next);}
    else void run(()=>submit(current,next));
  }
  const isText=!!fieldDescriptor&&confirmed&&['text','multiline','secret'].includes(fieldDescriptor.kind);
  useInput((_input,key)=>{
    if(key.eventType==='release')return;
    const current=actionNow.current, currentField=current?.fields?.[fieldNow.current];
    const textActive=currentField&&confirmedNow.current&&['text','multiline','secret'].includes(currentField.kind);
    if(busyNow.current||textActive)return;
    if(!action&&resource&&(key.pageUp||key.pageDown)){setBodyOffset(value=>Math.max(0,Math.min(Math.max(0,bodyLines.length-bodyRows),value+(key.pageDown?bodyRows:-bodyRows))));return;}
    if(key.escape){epoch.current++;if(action)setAction(undefined);else if(resource)setResource(undefined);else{setCollection(undefined);setItems([]);}setSelected(0);return;}
    const count=action?choices.length:lines.length;
    if(key.upArrow)setSelected(value=>Math.max(0,value-1));
    if(key.downArrow)setSelected(value=>Math.min(count-1,value+1));
    if(key.return){
      if(current&&!confirmedNow.current){if(selectedNow.current===0)setAction(undefined);else if(current.fields?.length){setConfirmed(true);prepareField(current.fields[0],valuesNow.current);}else void run(()=>submit(current,{}));}
      else if(currentField)nextField(currentField.kind==='toggle'?selectedNow.current===1:currentField.options?.[selectedNow.current]?.value);
      else lines[selectedNow.current]?.run();
    }
  });
  const bodyRows=Math.max(3,Math.floor(rows/3));
  const bodyLines=wrapAnsi((resource?.blocks??[]).filter(block=>block.primitive!=='form').map(block=>terminalText(block.fallbackMarkdown)).filter(Boolean).join('\n\n'),Math.max(10,columns-4),{hard:true,trim:false}).split('\n');
  const pageSize=Math.max(3,Math.floor((rows-12)/2));
  const start=Math.max(0,selected-pageSize+1);
  return <Box flexDirection="column" gap={1}>
    <Text bold>{resource?txt(resource.display.title):collection?txt(collection.title):t.resources}{busy?` · ${t.loading}`:''}</Text>
    {resource&&!action&&<Box flexDirection="column"><Text>{bodyLines.slice(bodyOffset,bodyOffset+bodyRows).join('\n')}</Text>{bodyLines.length>bodyRows&&<Text dimColor>{bodyOffset+1}–{Math.min(bodyOffset+bodyRows,bodyLines.length)} / {bodyLines.length} · PgUp / PgDn</Text>}</Box>}
    {action?<>
      <Text>{!confirmed?txt(action.confirmation?.title):fieldDescriptor?txt(fieldDescriptor.label):txt(action.label)}</Text>
      {!confirmed&&action.confirmation?.body&&<Text>{txt(action.confirmation.body)}</Text>}
      {isText?<Input value={input} onChange={setInput} active={!busy} secret={fieldDescriptor?.kind==='secret'} multiline={fieldDescriptor?.kind==='multiline'} onSubmit={nextField} onCancel={()=>setAction(undefined)} />
        :choices.map((choice,index)=><Text key={index} bold={index===selected}>{index===selected?'› ':'  '}{choice}</Text>)}
    </>:lines.slice(start,start+pageSize).map((line,index)=><Text key={line.id} bold={selected===index+start}>{selected===index+start?'› ':'  '}{line.title}</Text>)}
    {notice&&<Text>{notice}</Text>}{error&&<Text color="red">{error}</Text>}
  </Box>;
}
