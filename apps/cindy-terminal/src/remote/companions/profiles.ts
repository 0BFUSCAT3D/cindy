import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CINDY_DEFAULT_IDENTITY } from '@cindy/companion-core/botTemplatePreset';
import { buildDefaultBotIdentity } from '@cindy/companion-core/profileDefaults';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../../platform.js';
import { parseSelection, type ModelSelection } from '../../models/config.js';

export interface TerminalCompanionProfile {
  id:string; name:string; description:string; avatar:string; status:'active'|'paused';
  version:number; createdAt:number; updatedAt:number; models:ModelSelection[];
  sessionId:string; templateId?:'cindy';
}
const idOf=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error('INVALID_COMPANION_ID');return value;};
const fileOf=(value:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value)||value==='..')throw new Error('INVALID_COMPANION_FILE');return value;};

/** Permanent account-owned Profiles; native sessions are replaceable handles.
 * Secrets, native login and long model history never travel inside this file. */
export class TerminalCompanionProfiles {
  private readonly file:string;
  private value:TerminalCompanionProfile[]=[];
  private writes:Promise<void>=Promise.resolve();
  private readonly ready:Promise<void>;
  constructor(readonly root:string,private readonly guard:()=>void){
    this.file=path.join(root,'profiles.json');
    const file=this.file;this.ready=(async()=>{await privateDirectory(root);const raw=await readPrivateFile(file);if(!raw)return;
      const data=JSON.parse(raw.toString()) as {version?:unknown;profiles?:unknown};
      if(data.version!==1||!Array.isArray(data.profiles))throw new Error('INVALID_COMPANION_PROFILES');
      this.value=data.profiles.map(row=>{if(!row||typeof row!=='object')throw new Error('INVALID_COMPANION_PROFILE');idOf(row.id);idOf(row.sessionId);if(typeof row.name!=='string'||!['active','paused'].includes(row.status)||!Array.isArray(row.models)||row.models.length>5)throw new Error('INVALID_COMPANION_PROFILE');return {...row,models:row.models.map(parseSelection)};});
    })();
  }
  home(id:string){return path.join(this.root,'homes',idOf(id));}
  private update(run:(next:TerminalCompanionProfile[])=>Promise<void>){const job=this.writes.then(async()=>{await this.ready;this.guard();const next=structuredClone(this.value);await run(next);this.guard();await atomicPrivateWrite(this.file,JSON.stringify({version:1,profiles:next}));this.value=next;});this.writes=job.catch(()=>undefined);return job;}
  async list(){await this.ready;await this.writes;this.guard();return structuredClone(this.value);}
  async get(id:string){return (await this.list()).find(row=>row.id===id)??null;}
  async create(input:{id?:string;name:string;description?:string;soul?:string;user?:string;avatar?:string;templateId?:'cindy'}){
    const id=idOf(input.id??randomUUID()),now=Date.now();if(!input.name.trim()||input.name.length>128)throw new Error('INVALID_COMPANION_NAME');
    await this.update(async next=>{if(next.some(row=>row.id===id))throw new Error('COMPANION_ALREADY_EXISTS');
      const home=this.home(id);for(const dir of [home,path.join(home,'workspace'),path.join(home,'memories'),path.join(home,'skills')])await privateDirectory(dir);
      await atomicPrivateWrite(path.join(home,'SOUL.md'),input.soul??(input.templateId==='cindy'?CINDY_DEFAULT_IDENTITY:buildDefaultBotIdentity(input.name,input.description)));
      await atomicPrivateWrite(path.join(home,'USER.md'),input.user??'');
      next.push({id,name:input.name,description:input.description??'',avatar:input.avatar??(input.templateId==='cindy'?'cindy://avatar/preset/cindy':''),status:'active',version:1,createdAt:now,updatedAt:now,models:[],sessionId:`companion_${createHash('sha256').update(id).digest('hex').slice(0,40)}`,...(input.templateId?{templateId:input.templateId}:{})});
    });return (await this.get(id))!;
  }
  async change(id:string,patch:Partial<Pick<TerminalCompanionProfile,'name'|'description'|'avatar'|'status'|'models'>>){
    await this.update(async next=>{const row=next.find(row=>row.id===id);if(!row)throw new Error('COMPANION_NOT_FOUND');
      if(patch.name!==undefined&&(!patch.name.trim()||patch.name.length>128))throw new Error('INVALID_COMPANION_NAME');
      if(patch.status!==undefined&&!['active','paused'].includes(patch.status))throw new Error('INVALID_COMPANION_STATUS');
      if(patch.models!==undefined&&(!Array.isArray(patch.models)||patch.models.length>5))throw new Error('INVALID_COMPANION_MODELS');
      Object.assign(row,{...patch,...(patch.models?{models:patch.models.map(parseSelection)}:{})},{updatedAt:Date.now(),version:row.version+1});
    });return (await this.get(id))!;
  }
  private async checkedPath(id:string,...parts:string[]) {
    if(!await this.get(id))throw new Error('COMPANION_NOT_FOUND');
    const home=this.home(id);const root=await realpath(this.root);const homeReal=await realpath(home);
    if(path.relative(root,homeReal).startsWith('..')||path.isAbsolute(path.relative(root,homeReal)))throw new Error('UNSAFE_COMPANION_PATH');
    let directory=home;
    for(const part of parts.slice(0,-1)){directory=path.join(directory,part);await privateDirectory(directory);const info=await lstat(directory);if(info.isSymbolicLink())throw new Error('UNSAFE_COMPANION_PATH');}
    this.guard();return path.join(home,...parts);
  }
  async read(id:string,name:string){const file=await this.checkedPath(id,fileOf(name));const raw=await readPrivateFile(file);this.guard();return raw?.toString()??null;}
  async write(id:string,name:string,text:string){const file=await this.checkedPath(id,fileOf(name));if(Buffer.byteLength(text)>1024*1024)throw new Error('COMPANION_FILE_TOO_LARGE');await atomicPrivateWrite(file,text);this.guard();}
  async files(id:string,kind:'memories'|'skills'){const file=await this.checkedPath(id,kind,'_');return readdir(path.dirname(file));}
  async readMemory(id:string,name:string){const file=await this.checkedPath(id,'memories',fileOf(name));const raw=await readPrivateFile(file);this.guard();return raw?.toString()??null;}
  async writeMemory(id:string,name:string,text:string){const file=await this.checkedPath(id,'memories',fileOf(name));if(Buffer.byteLength(text)>1024*1024)throw new Error('COMPANION_FILE_TOO_LARGE');await atomicPrivateWrite(file,text);this.guard();}
  async removeMemory(id:string,name:string){const file=await this.checkedPath(id,'memories',fileOf(name));await rm(file,{force:true});this.guard();}
  async readSkill(id:string,slug:string){const file=await this.checkedPath(id,'skills',idOf(slug),'SKILL.md');const raw=await readPrivateFile(file);this.guard();return raw?.toString()??null;}
  async writeSkill(id:string,slug:string,text:string){const file=await this.checkedPath(id,'skills',idOf(slug),'SKILL.md');if(Buffer.byteLength(text)>1024*1024)throw new Error('COMPANION_FILE_TOO_LARGE');await atomicPrivateWrite(file,text);this.guard();}
  async removeSkill(id:string,slug:string){const file=await this.checkedPath(id,'skills',idOf(slug),'SKILL.md');await rm(path.dirname(file),{recursive:true,force:true});this.guard();}
  async remove(id:string){await this.update(async next=>{const index=next.findIndex(row=>row.id===id);if(index>=0)next.splice(index,1);});/* Home retained until explicit data removal; deleting a Profile never recreates it. */}
  async close(){await this.writes;}
}
