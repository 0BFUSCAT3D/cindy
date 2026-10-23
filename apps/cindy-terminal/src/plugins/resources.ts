import type { RemoteResourceRegistry, RemoteResource, RemoteLocalizedText } from '@cindy/device-link';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { ghostPermissionItems, type GhostPermissionItem, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import type { TerminalPlugins } from './host.js';
import permissions from './permissions.json';

const copy={
  plugins:['Plugins','插件','外掛','プラグイン','플러그인'],install:['Install package','安装插件包','安裝外掛套件','パッケージをインストール','패키지 설치'],
  file:['Package path (.cindy)','插件包路径（.cindy）','外掛套件路徑（.cindy）','パッケージのパス（.cindy）','패키지 경로(.cindy)'],
  confirm:['Install with these permissions?','允许以上权限并安装？','允許以上權限並安裝？','これらの権限でインストールしますか？','이 권한으로 설치할까요?'],
  proceed:['Confirm installation','确认安装','確認安裝','インストールを確認','설치 확인'],cancel:['Cancel','取消','取消','キャンセル','취소'],
  enable:['Enable','启用','啟用','有効にする','활성화'],disable:['Disable','停用','停用','無効にする','비활성화'],
  remove:['Uninstall','卸载','解除安裝','アンインストール','제거'],removeConfirm:['Uninstall this plugin?','卸载此插件？','解除安裝此外掛？','このプラグインを削除しますか？','이 플러그인을 제거할까요?'],
  credentials:['Credentials','凭证','憑證','認証情報','인증 정보'],key:['Credential','凭证','憑證','認証情報','인증 정보'],value:['New value','新值','新值','新しい値','새 값'],
} as const;
const label=(key:keyof typeof copy):RemoteLocalizedText=>{const [fallback,cn,tw,ja,ko]=copy[key];return {fallback,translations:{en:fallback,'zh-CN':cn,'zh-TW':tw,ja,ko}};};
const ref=(id:string)=>({collectionId:'plugins',kind:'plugin',id});
function permissionText(items:GhostPermissionItem[],locale='en'){
  const dictionary=(permissions as Record<string,Record<string,string>>)[locale]??permissions.en;
  const format=(key:string,args:Record<string,string>={})=>(dictionary[key]??(permissions.en as Record<string,string>)[key]??key).replace(/\{\{(\w+)\}\}/g,(_match,name)=>args[name]??'');
  return items.map(item=>[format(item.labelKey,item.labelArgs),item.detailKey?format(item.detailKey,item.detailArgs):'',item.detail??''].filter(Boolean).join('\n')).join('\n\n');
}
function secretFields(ghost:InstalledGhost){
  const keys=new Map<string,string>();
  for(const secret of ghost.manifest.network?.secrets??[])if(['user','gh-cli'].includes(secret.source??'user'))keys.set(secret.key,secret.label);
  for(const binding of ghost.manifest.node?.secretBindings??[])if(!binding.oauthSecret)keys.set(binding.key,binding.label);
  return [...keys].map(([value,label])=>({value,label}));
}

export function registerPluginResources(registry:RemoteResourceRegistry,host:TerminalPlugins){
  const installed=(ghost:InstalledGhost,locale?:string):RemoteResource=>{
    const id=installedGhostStoragePart(ghost),secrets=secretFields(ghost);
    return {ref:ref(id),revision:host.version(),display:{title:ghost.manifest.name,subtitle:ghost.manifest.version},links:[],
      blocks:[{id:'permissions',primitive:'text',fallbackMarkdown:permissionText(ghostPermissionItems(ghost.manifest),locale)}],
      actions:[{id:ghost.enabled?'disable':'enable',label:label(ghost.enabled?'disable':'enable')},
        ...(secrets.length?[{id:'credentials',label:label('credentials'),fields:[{id:'key',kind:'select',label:label('key'),required:true,options:secrets},{id:'value',kind:'secret',label:label('value')}]}]:[]),
        {id:'remove',label:label('remove'),tone:'destructive',confirmation:{title:label('removeConfirm')}}]};
  };
  const prepared=(id:string,controller:string,locale?:string):RemoteResource=>{
    const pending=host.pendingInstall(id,controller),facts=pending.facts;
    return {ref:ref(`install:${id}`),revision:pending.inspected.packageSha256,display:{title:facts.name,subtitle:facts.version},links:[],
      blocks:[{id:'permissions',primitive:'text',fallbackMarkdown:permissionText(ghostPermissionItems(pending.inspected.manifest),locale)}],
      actions:[{id:'confirm-install',label:label('proceed'),confirmation:{title:label('confirm')}},{id:'cancel-install',label:label('cancel')}]};
  };
  registry.register({collection:{id:'plugins',resourceKind:'plugin',title:label('plugins'),placement:'settings',actions:[{id:'install',label:label('install'),fields:[{id:'file',kind:'text',label:label('file'),required:true}]}]},
    list:async(context,request)=>{
      const offset=request.cursor===undefined?0:Number(request.cursor),limit=Math.min(request.limit??100,200);
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw new Error('INVALID_CURSOR');
      const query=request.query?.toLowerCase();
      const items=[...(await host.list()).map(ghost=>installed(ghost,request.client.locale)),...host.pendingFor(context.controllerDeviceId).map(p=>prepared(p.id,context.controllerDeviceId,request.client.locale))]
        .filter(item=>!query||`${item.display.title} ${item.display.subtitle}`.toLowerCase().includes(query));
      return {collectionId:'plugins',revision:host.version(),items:items.slice(offset,offset+limit),...(offset+limit<items.length?{nextCursor:String(offset+limit)}:{})};
    },
    get:async(context,request)=>request.ref.id.startsWith('install:')?prepared(request.ref.id.slice(8),context.controllerDeviceId,request.client.locale):installed(await host.get(request.ref.id),request.client.locale),
    invoke:async(context,request)=>{
      context.assertCurrent?.();const id=request.resourceRef?.id;
      if(request.actionId==='install'){
        const file=request.input?.file;if(typeof file!=='string')throw new Error('PLUGIN_PACKAGE_PATH_REQUIRED');
        const prepared=await host.prepareInstall(file,context.controllerDeviceId);context.assertCurrent?.();
        return {effects:[{kind:'navigate',target:{kind:'resource',ref:ref(`install:${prepared.id}`)}}]};
      }
      if(!id)throw new Error('PLUGIN_ID_REQUIRED');
      if(id.startsWith('install:')){
        if(request.actionId==='confirm-install')await host.confirmInstall(id.slice(8),context.controllerDeviceId,context.assertCurrent);
        else if(request.actionId==='cancel-install')host.cancelInstall(id.slice(8),context.controllerDeviceId);
        else throw new Error('INVALID_ACTION');
      }else if(['enable','disable'].includes(request.actionId))await host.setEnabled(id,request.actionId==='enable');
      else if(request.actionId==='remove')await host.uninstall(id);
      else if(request.actionId==='credentials'){
        const key=request.input?.key,value=request.input?.value;if(typeof key!=='string'||typeof value!=='string')throw new Error('PLUGIN_SECRET_INVALID');
        await host.saveSecret(id,key,value);
      }else throw new Error('INVALID_ACTION');
      return {effects:[{kind:'refresh-collection',collectionId:'plugins'}]};
    },
  });
}
