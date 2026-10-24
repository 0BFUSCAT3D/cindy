import { TerminalPluginSessions } from './sessions.js';
import path from 'node:path';
import { isCindyAccountGhostId } from '@cindy/plugin-runtime/shared/ghost';
import type { GhostVisibilityDeps } from '@cindy/plugin-runtime/ghostVisibility';
import type { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { TerminalProtectedInput } from '../protected-input.js';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginAccount } from './account.js';
import { TerminalPluginPreferences } from './preferences.js';
import { TerminalPluginSetup } from './setup.js';
import { TerminalPluginPages } from './pages.js';
import { TerminalPluginPublisher } from './publisher.js';
import { createTerminalPluginTask } from './mcp.js';
import { createTerminalPluginForge } from './forge.js';
import type { TerminalPluginMarket } from './market.js';
import translations from './translations.json';

/** Owner-scoped wiring; no process-global Desktop singleton is borrowed. */
export class TerminalPluginTasks {
  readonly sessions:TerminalPluginSessions;
  readonly setup:TerminalPluginSetup;
  readonly pages:TerminalPluginPages;
  readonly preferences:TerminalPluginPreferences;
  readonly publisher:TerminalPluginPublisher;
  readonly ready:Promise<void>;
  private closed=false;
  constructor(private readonly options:{
    root:string;runtimeDirectory:string;host:TerminalPlugins;account:TerminalPluginAccount;market:TerminalPluginMarket;
    tasks:TerminalTaskHost;protectedInput:Pick<TerminalProtectedInput,'configurePlugins'>;deposits:DirDepositVault;saves:SaveDepositVault;
    owner():import('@cindy/plugin-runtime/owner').PluginOwner;
    signedIn():boolean;remoteAvailable(peer:string):boolean;locale():string;assertCurrent():void;
    emit(channel:string,payload:unknown):void;
  }){
    const guard=()=>{if(this.closed)throw new Error('PLUGIN_TASKS_CLOSED');options.assertCurrent();};
    const translate=(key:string)=>((translations as Record<string,Record<string,string>>)[options.locale()]??translations.en)[key]??(translations.en as Record<string,string>)[key]??key;
    this.sessions=new TerminalPluginSessions({root:options.root,host:options.host,tasks:options.tasks,guard,translate});
    options.host.configureTaskSessions(this.sessions);
    this.preferences=new TerminalPluginPreferences(options.root,guard);
    const visibility:GhostVisibilityDeps={translate,listGhosts:()=>{guard();return options.host.native.list();},
      isAvailableForActiveSession:id=>{guard();const ghost=options.host.installed(id);return !!ghost&&(!isCindyAccountGhostId(ghost.manifest.id)||options.signedIn());},
      isDisabledForWorkdir:(id,dir)=>this.preferences.disabled(id,dir),
    };
    this.pages=new TerminalPluginPages(options.host,{assertCurrent:guard,translate:(key,locale)=>((translations as Record<string,Record<string,string>>)[locale??options.locale()]??translations.en)[key]??(translations.en as Record<string,string>)[key]??key});
    const pages=this.pages.pages;
    this.setup=new TerminalPluginSetup(options.host,{visibility,owner:()=>JSON.stringify(options.owner()),remoteAvailable:options.remoteAvailable,translate,assertCurrent:guard,emit:options.emit,
      settings:{bind:action=>pages.settingsBinding(action),bindAuthorization:action=>pages.settingsAuthorizationBinding(action),runAuthorization:action=>pages.runSettingsAuthorization(action),request:(peer,request)=>pages.settingsRequest(peer,request)},
      navigate:(sessionId,target,ghostId)=>options.emit('terminal:plugin-settings',{sessionId,target,ghostId}),
    });
    this.publisher=new TerminalPluginPublisher({stagingDirectory:path.join(options.root,'plugin-publish-staging'),host:options.host,account:options.account,owner:options.owner,assertCurrent:guard,
      onProgress:progress=>options.emit('ghosts:publish-progress',progress),
    });
    options.protectedInput.configurePlugins(this.setup.authorization);
    options.tasks.configurePlugins(async context=>{
      guard();await this.ready;await this.preferences.refresh();guard();
      const scoped={...context,assertCurrent:()=>{guard();context.assertCurrent();}};
      return createTerminalPluginTask({host:options.host,setup:this.setup,preferences:this.preferences,visibility,context:scoped,media:options.tasks.media,deposits:options.deposits,saves:options.saves,
        market:options.market.task(scoped,options.tasks.requestHostPermission,translate),
        forge:createTerminalPluginForge({...options,context:scoped,media:options.tasks.media,publisher:this.publisher,requestPermission:options.tasks.requestHostPermission,translate}),
      });
    },this.setup);
    this.ready=Promise.all([this.preferences.refresh(),this.sessions.ready]).then(()=>undefined);
  }
  async close(){if(this.closed)return;this.closed=true;this.pages.close();this.setup.close();this.publisher.close();await this.sessions.close();}
}
