import type { RemoteResourceRegistry, RemoteCollectionItem, RemoteActionDescriptor } from '@cindy/device-link';
import type { TerminalCompanionHost } from './host.js';
import { remoteText as text } from '../text.js';
import { parseSelection } from '../../models/config.js';
const string=(value:unknown)=>{if(typeof value!=='string'||!value.trim())throw new Error('INVALID_ARGUMENT');return value;};
export function registerCompanionResources(registry:RemoteResourceRegistry,host:TerminalCompanionHost){
  const actions:RemoteActionDescriptor[]=[{id:'create',label:text('Add teammate'),fields:[{id:'name',label:text('Name'),kind:'text',required:true},{id:'description',label:text('Description'),kind:'multiline'}]}];
  const item=async(id:string):Promise<RemoteCollectionItem>=>{const profile=await host.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');return {ref:{collectionId:'teammates',kind:'bot',id},revision:String(profile.version),display:{title:profile.name,subtitle:profile.description,status:{label:text(profile.status==='paused'?'Paused':'Ready'),tone:profile.status==='paused'?'neutral':'positive'}},links:[],actions:[{id:'open',label:text('Open conversation')},{id:'edit',label:text('Edit profile'),fields:[{id:'name',label:text('Name'),kind:'text',required:true},{id:'description',label:text('Description'),kind:'multiline'},{id:'soul',label:text('Identity'),kind:'multiline'}]},{id:profile.status==='paused'?'resume':'pause',label:text(profile.status==='paused'?'Resume':'Pause')},{id:'delete',label:text('Delete teammate'),tone:'destructive'}]};};
  registry.register({collection:{id:'teammates',resourceKind:'bot',title:text('Teammates'),placement:'home-scope',actions},
    list:async(_context,request)=>{const query=request.query?.toLowerCase();const rows=(await host.profiles.list()).filter(profile=>!query||(profile.name+' '+profile.description).toLowerCase().includes(query));return {collectionId:'teammates',revision:rows.map(row=>row.id+':'+row.version).join('|'),items:await Promise.all(rows.slice(0,request.limit??200).map(row=>item(row.id)))};},
    get:async(_context,request)=>{const result=await item(request.ref.id);const profile=await host.profiles.get(request.ref.id);return {...result,blocks:[{id:'profile',primitive:'text',fallbackMarkdown:profile!.description}]};},
    invoke:async(context,request)=>{context.assertCurrent?.();const input=request.input??{};const id=request.resourceRef?.id;
      if(request.actionId==='create'){const profile=await host.create({name:string(input.name),description:typeof input.description==='string'?input.description:''});context.assertCurrent?.();return {result:{botId:profile.id},effects:[{kind:'refresh-collection',collectionId:'teammates'}]};}
      if(!id)throw new Error('COMPANION_NOT_FOUND');if(request.actionId==='open'){const profile=await host.profiles.get(id);if(!profile)throw new Error('COMPANION_NOT_FOUND');await host.ensureCanonical(profile);return {result:{sessionId:profile.sessionId},effects:[{kind:'navigate',target:{kind:'session',sessionId:profile.sessionId}}]};}
      if(request.actionId==='edit'){await host.change(id,{name:string(input.name),description:typeof input.description==='string'?input.description:''});if(typeof input.soul==='string')await host.profiles.write(id,'SOUL.md',input.soul);}
      else if(request.actionId==='pause'||request.actionId==='resume')await host.change(id,{status:request.actionId==='pause'?'paused':'active'});
      else if(request.actionId==='delete')await host.remove(id);
      else if(request.actionId==='model'){await host.change(id,{models:[parseSelection(input)]});}
      else if(request.actionId==='model-default')await host.change(id,{models:[]});
      else throw new Error('INVALID_ACTION');context.assertCurrent?.();return {effects:[{kind:'refresh-collection',collectionId:'teammates'},{kind:'refresh-resource',ref:request.resourceRef!}]};
    }
  });
}
