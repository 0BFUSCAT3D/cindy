import path from 'node:path';
import { normalizeGhostWorkdirPrefs, normalizeWorkdirKey, type GhostWorkdirPrefs } from '@cindy/plugin-runtime/ghostWorkdirPrefs';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';

export class TerminalPluginPreferences {
  private value:GhostWorkdirPrefs={disabledByWorkdir:{}};
  private writes:Promise<unknown>=Promise.resolve();
  constructor(private readonly root:string,private readonly guard:()=>void){}
  async refresh(){
    this.guard();await this.writes;
    const bytes=await readPrivateFile(path.join(this.root,'ghost-workdir-prefs.json'));this.guard();
    this.value=normalizeGhostWorkdirPrefs(bytes?JSON.parse(bytes.toString()):{});
  }
  disabled(id:string,workdir:string|null){this.guard();return !!workdir&&Boolean(this.value.disabledByWorkdir[normalizeWorkdirKey(workdir)]?.includes(id));}
  set(workdir:string,id:string,disabled:boolean){
    const next=this.writes.then(async()=>{
      this.guard();const key=normalizeWorkdirKey(workdir);if(!key)throw new Error('WORKDIR_REQUIRED');
      const bytes=await readPrivateFile(path.join(this.root,'ghost-workdir-prefs.json'));this.guard();
      const value=normalizeGhostWorkdirPrefs(bytes?JSON.parse(bytes.toString()):{}),ids=new Set(value.disabledByWorkdir[key]??[]);
      disabled?ids.add(id):ids.delete(id);
      if(ids.size)value.disabledByWorkdir[key]=[...ids].sort();else delete value.disabledByWorkdir[key];
      await atomicPrivateWrite(path.join(this.root,'ghost-workdir-prefs.json'),JSON.stringify(value));this.guard();this.value=value;
      return value.disabledByWorkdir[key]??[];
    });this.writes=next.catch(()=>{});return next;
  }
}
