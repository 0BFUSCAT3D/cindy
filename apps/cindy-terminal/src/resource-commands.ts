import type { RemoteActionDescriptor, RemoteCollectionDescriptor, RemoteCollectionItem, RemoteResource } from '@cindy/device-link';
import type { TerminalClient } from './contracts.js';
import type { Locale } from './ui/i18n.js';

export const resourceCollections:Record<string,string>={
  teammates:'teammates',schedules:'schedules',projects:'projects',plugins:'plugins',skills:'skills',
  mcp:'mcp',channels:'channels',memory:'memory',contacts:'contacts',shares:'provider-shares','provider-groups':'provider-groups',
};

/** Named commands consume the same advertised actions as TUI/GUI. Resource
 * kinds and operation IDs come from the target host, including older hosts. */
export async function runResourceCommand(client:TerminalClient,options:{collection:string;operation:string;id?:string;input?:unknown;device?:string;locale:Locale;cursor?:string;limit?:number}){
  const descriptor={protocolVersion:1,primitives:['text','actions','session-controls'],locale:options.locale};
  const call=<T>(name:string,args:Record<string,unknown>)=>client.invoke<T>(`maker:remote-resources:${name}`,[{client:descriptor,...args}],options.device);
  const manifest=await call<{collections:RemoteCollectionDescriptor[]}>('manifest',{});
  const collection=manifest.collections.find(item=>item.id===options.collection);
  if(!collection)throw new Error('CAPABILITY_NOT_AVAILABLE_ON_TARGET');
  if(options.operation==='list')return call('list',{collectionId:collection.id,limit:options.limit??100,...(options.cursor?{cursor:options.cursor}:{})});
  let resource:RemoteResource|undefined;
  if(options.id){
    let cursor:string|undefined;const seen=new Set<string>();
    for(;;){
      const page=await call<{items:RemoteCollectionItem[];nextCursor?:string}>('list',{collectionId:collection.id,limit:100,...(cursor?{cursor}:{})});
      const item=page.items.find(item=>item.ref.id===options.id);
      if(item){resource=await call<RemoteResource>('get',{ref:item.ref});break;}
      if(!page.nextCursor)throw new Error('RESOURCE_NOT_FOUND');
      if(seen.has(page.nextCursor))throw new Error('INVALID_RESOURCE_CURSOR');
      cursor=page.nextCursor;seen.add(cursor);
    }
  }
  if(options.operation==='get'||options.operation==='show'){
    if(!resource)throw new Error('RESOURCE_ID_REQUIRED');return resource;
  }
  const actions:RemoteActionDescriptor[]=resource?.actions??collection.actions??[];
  const action=actions.find(item=>item.id===options.operation);
  if(!action)throw new Error('ACTION_NOT_AVAILABLE_ON_TARGET');
  if(action.disabled)throw new Error('RESOURCE_ACTION_DISABLED');
  return call('invoke',{collectionId:collection.id,actionId:action.id,...(resource?{resourceRef:resource.ref}:{}),input:options.input??{}});
}
