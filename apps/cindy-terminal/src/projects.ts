import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RemoteResourceRegistry, RemoteText, RemoteCollectionItem } from '@cindy/device-link';
import { atomicPrivateWrite, readPrivateFile } from './platform.js';

const schema=z.array(z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(200),directory:z.string().min(1).refine(path.isAbsolute),createdAt:z.number(),updatedAt:z.number()}).strict());
type Project=z.infer<typeof schema>[number];
const copy={projects:['Projects','项目','專案','プロジェクト','프로젝트'],add:['Add folder','添加文件夹','加入資料夾','フォルダーを追加','폴더 추가'],name:['Name','名称','名稱','名前','이름'],folder:['Folder','文件夹','資料夾','フォルダー','폴더'],open:['New session here','在此新建任务','在此新增任務','ここでセッションを作成','여기서 세션 만들기'],edit:['Rename','重命名','重新命名','名前を変更','이름 바꾸기'],remove:['Remove from projects','移出项目列表','從專案清單移除','プロジェクト一覧から削除','프로젝트 목록에서 제거']} as const;
const t=(key:keyof typeof copy):RemoteText=>{const [fallback,cn,tw,ja,ko]=copy[key];return {fallback,translations:{'zh-CN':cn,'zh-TW':tw,ja,ko}};};

/** Project registration is separate from the folder and its task histories. */
export class TerminalProjects {
  private rows:Project[]=[];
  private writes:Promise<unknown>=Promise.resolve();
  private active=true;
  readonly ready:Promise<void>;
  constructor(private root:string,private options:{guard():void;createSession(directory:string,title:string):Promise<string>}){this.ready=this.open();}
  private guard(){if(!this.active)throw new Error('PROJECTS_CLOSED');this.options.guard();}
  private async open(){const raw=await readPrivateFile(path.join(this.root,'projects.json'));this.guard();if(raw)this.rows=schema.parse(JSON.parse(raw.toString()));}
  private async change(update:(rows:Project[])=>Project[],guard:()=>void){
    await this.ready;
    const work=this.writes.then(async()=>{this.guard();guard();const next=schema.parse(update(this.rows));await atomicPrivateWrite(path.join(this.root,'projects.json'),JSON.stringify(next));this.guard();guard();this.rows=next;});
    this.writes=work.catch(()=>{});return work;
  }
  register(registry:RemoteResourceRegistry){
    const item=(row:Project):RemoteCollectionItem=>({ref:{collectionId:'projects',kind:'project',id:row.id},display:{title:row.name,subtitle:row.directory},links:[],revision:String(row.updatedAt),actions:[{id:'open',label:t('open')},{id:'rename',label:t('edit'),fields:[{id:'name',kind:'text',label:t('name'),required:true}]},{id:'remove',label:t('remove')}]});
    registry.register({collection:{id:'projects',resourceKind:'project',title:t('projects'),placement:'settings',actions:[{id:'add',label:t('add'),fields:[{id:'directory',label:t('folder'),kind:'text',required:true},{id:'name',label:t('name'),kind:'text'}]}]},
      list:async(context,request)=>{await this.ready;this.guard();context.assertCurrent?.();const rows=this.rows.filter(row=>!request.query||`${row.name} ${row.directory}`.toLowerCase().includes(request.query.toLowerCase()));const offset=request.cursor?Number(request.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('INVALID_CURSOR');const limit=Math.min(request.limit??100,200);return {collectionId:'projects',revision:String(this.rows.reduce((value,row)=>Math.max(value,row.updatedAt),0)),items:rows.slice(offset,offset+limit).map(item),...(offset+limit<rows.length?{nextCursor:String(offset+limit)}:{})};},
      get:async(context,request)=>{await this.ready;this.guard();context.assertCurrent?.();const row=this.rows.find(row=>row.id===request.ref.id);if(!row)throw new Error('PROJECT_NOT_FOUND');return {...item(row),blocks:[{id:'directory',primitive:'text',fallbackMarkdown:row.directory},{id:'rename',primitive:'form',fallbackMarkdown:'',data:{actionId:'rename',values:{name:row.name}}}]};},
      invoke:async(context,request)=>{
        await this.ready;this.guard();context.assertCurrent?.();
        if(request.actionId==='add'){
          const input=z.object({directory:z.string().min(1).refine(path.isAbsolute),name:z.string().max(200).optional()}).parse(request.input);
          const directory=await realpath(input.directory);if(!(await stat(directory)).isDirectory())throw new Error('PROJECT_FOLDER_REQUIRED');
          const now=Date.now();await this.change(rows=>rows.some(row=>row.directory===directory)?rows:[...rows,{id:randomUUID(),name:input.name?.trim()||path.basename(directory)||directory,directory,createdAt:now,updatedAt:now}],()=>context.assertCurrent?.());
        }else{
          const row=this.rows.find(row=>row.id===request.resourceRef?.id);if(!row)throw new Error('PROJECT_NOT_FOUND');
          if(request.actionId==='open'){const id=await this.options.createSession(row.directory,row.name);return {effects:[{kind:'navigate',target:{kind:'session',sessionId:id}}]};}
          if(request.actionId==='rename'){const name=z.string().trim().min(1).max(200).parse(request.input?.name);await this.change(rows=>rows.map(value=>value.id===row.id?{...value,name,updatedAt:Date.now()}:value),()=>context.assertCurrent?.());}
          else if(request.actionId==='remove')await this.change(rows=>rows.filter(value=>value.id!==row.id),()=>context.assertCurrent?.());
          else throw new Error('INVALID_ACTION');
        }
        return {effects:[{kind:'refresh-collection',collectionId:'projects'}]};
      },
    });
  }
  async close(){this.active=false;await this.writes;}
}
