import path from 'node:path';
import { open, lstat, realpath, chmod, stat, readFile } from 'node:fs/promises';
import { readBoundedFileNoFollow } from '@cindy/remote-agent/readBoundedFile';
import { GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE } from '@cindy/plugin-runtime/shared/ghost';
import {ghostCards} from '@cindy/plugin-runtime/cardSchema';
import * as pluginCards from '@cindy/plugin-runtime/cardStoreDb';
import type {GhostCardRow} from '@cindy/plugin-runtime/cardService';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createBlobStore, sniffMediaMime, recordBlob, addRef, hasRef, removeRefs, removeRefById, sessionCanRead, ghostCanRead, getBlobInfo } from '@cindy/media-core';
import { createLegacyImageCache } from '@cindy/media-core/legacy-image-cache';
import { createIntegrationCache, integrationCacheKey } from '@cindy/media-core/integration-cache';
import { getIntegrationCacheHash, touchBlob, pinBlob, type LedgerDb } from '@cindy/media-core/ledger';
import { verifiedInboundMediaMime } from '@cindy/media-core/inbound-media-verify';
import type { IMHost } from '@cindy/im';
import { taskImageRoots, readTaskImage, type SessionImageScope } from '@cindy/media-core/task-image-source';
import { hasLocalTaskImages, materializeTaskImageMarkdown } from '@cindy/media-core/task-image-markdown';
import { materializeLocalMarkdownImages } from '@cindy/media-core/local-markdown-images';
import * as schema from '@cindy/media-core/schema';
import { privateDirectory } from '../platform.js';
import type { AttachmentResolution } from './input.js';

/** Uses the same byte store, tables and reference operations as Desktop.
 * A terminal profile is already isolated to one authenticated owner. */
export class TerminalTaskMedia {
  private readonly store;
  private readonly legacyImages;
  private native?: Database.Database;
  private db?: ReturnType<typeof drizzle<typeof schema>>;
  private operations: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly profileDir:string) { this.store=createBlobStore(()=>profileDir); this.legacyImages=createLegacyImageCache(()=>profileDir); this.ready=this.initialize(); }
  private async initialize() {
    const directory=path.join(this.profileDir,'cindy-media'); await privateDirectory(directory);
    const file=path.join(directory,'ledger.sqlite');
    // SQLite opens its own sidecars, so check all existing paths before it can follow links.
    for(const candidate of [file,`${file}-wal`,`${file}-shm`]) {
      const info=await lstat(candidate).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
      if(info&&(!info.isFile()||info.isSymbolicLink()||(process.platform!=='win32'&&typeof process.getuid==='function'&&info.uid!==process.getuid())))throw new Error('UNSAFE_MEDIA_DATABASE');
    }
    const database=new Database(file);
    this.native=database; database.pragma('foreign_keys = ON'); database.pragma('journal_mode = WAL');
    // These are the shared media tables, not Desktop's unrelated user database.
    database.exec(`CREATE TABLE IF NOT EXISTS media_blobs (hash TEXT PRIMARY KEY, ext TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, is_cache INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_refs (id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES media_blobs(hash) ON DELETE CASCADE, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, origin_session_id TEXT, origin_kind TEXT, origin_id TEXT, label TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS media_refs_hash_idx ON media_refs(hash);
CREATE INDEX IF NOT EXISTS media_refs_ref_idx ON media_refs(ref_kind,ref_id);`);
    database.exec(`CREATE TABLE IF NOT EXISTS ghost_cards(call_id TEXT PRIMARY KEY,ghost_id TEXT NOT NULL,session_id TEXT,html TEXT NOT NULL,height INTEGER NOT NULL,v INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ghost_cards_updated_at_idx ON ghost_cards(updated_at);`);
    if(process.platform!=='win32')await chmod(file,0o600);
    this.db=drizzle(database,{schema});
  }
  private run<T>(action:()=>Promise<T>):Promise<T> { const next=this.operations.then(async()=>{await this.ready;return action();});this.operations=next.catch(()=>{});return next; }
  ingest(input:{sessionId:string;bytes?:Buffer;path?:string;mimeType?:string;name?:string},guard:()=>void):Promise<AttachmentResolution> {
    return this.run(() => this.ingestOwned(input, guard));
  }
  private async ingestOwned(input:{sessionId:string;bytes?:Buffer;path?:string;mimeType?:string;name?:string;originKind?:'user'|'tool'},guard:()=>void,newRefs?:string[]):Promise<AttachmentResolution> {
      guard(); let probe:Buffer;
      if(input.bytes)probe=input.bytes.subarray(0,65536);
      else if(input.path){const handle=await open(input.path,'r');try{const info=await handle.stat();if(!info.isFile())throw new Error('INVALID_MEDIA_FILE');const bytes=Buffer.alloc(Math.min(info.size,65536));const read=await handle.read(bytes,0,bytes.length,0);probe=bytes.subarray(0,read.bytesRead);}finally{await handle.close();}}
      else throw new Error('MEDIA_BYTES_REQUIRED');
      const mimeType=sniffMediaMime(probe,input.mimeType);if(!mimeType)throw new Error('UNRECOGNIZED_MEDIA_TYPE');guard();
      const written=await this.store.writeBlob({...(input.bytes?{buffer:input.bytes}:{filePath:input.path!}),mimeType,assertStillValid:guard});guard();
      // Local SQLite commit and acknowledgement are in-process. Reference insert
      // and owner recheck share one transaction, so rollback needs no remote ACK journal.
      this.native!.exec('BEGIN IMMEDIATE');
      let addedRef: string | undefined;
      try {
        await recordBlob({...written,isCache:false},this.db!);guard();
        const originKind = input.originKind ?? 'user';
        if(!await hasRef({hash:written.hash,refKind:'session-attachment',refId:input.sessionId,originKind},this.db!))addedRef=await addRef({hash:written.hash,refKind:'session-attachment',refId:input.sessionId,originSessionId:input.sessionId,originKind,label:input.name},this.db!);
        guard();this.native!.exec('COMMIT');
      }catch(error){this.native!.exec('ROLLBACK');throw error;}
      if (addedRef) newRefs?.push(addedRef);
      const resolved=this.store.resolveSafe(written.url);return {path:resolved.absPath,managedUrl:written.url,mimeType};
  }
  resolveMediaUrl(url: string) { return this.store.resolveSafe(url); }
  resolveLegacyImageUrl(url: string) { return this.legacyImages.resolveSafe(url); }
  channelMedia(guard: () => void, warn: (message: string) => void, fetchRemoteImage: NonNullable<IMHost['media']>['fetchRemoteImage']): NonNullable<IMHost['media']> {
    const cache = createIntegrationCache<LedgerDb>({
      blobStore: this.store,
      ledger: {
        getIntegrationCacheHash: (key, db) => getIntegrationCacheHash(key, db ?? this.db!),
        getBlobInfo: (hash, db) => getBlobInfo(hash, db ?? this.db!),
        touchBlob: (hash, db) => touchBlob(hash, db ?? this.db!),
        addRef: (params, db) => addRef(params, db ?? this.db!),
        removeRefById: (id, db) => removeRefById(id, db ?? this.db!),
      },
      ingestMedia: async params => {
        guard();
        const written = await this.store.writeBlob({ ...params, assertStillValid: guard });
        guard(); await recordBlob({ ...written, isCache: params.isCache }, this.db!); guard();
        return written;
      },
      log: { warn },
    });
    const put = (params: Parameters<NonNullable<IMHost['media']>['cacheImage']>[0], kind: 'image' | 'av', isCache: boolean) => this.run(async () => {
      guard();
      const hit = await cache.integrationCachePut({
        ...params, cacheKey: integrationCacheKey(params.integration, params.token),
        mimeType: verifiedInboundMediaMime(params.buffer, params.mimeType, kind), isCache, assertStillValid: guard,
      }, this.db!);
      return { absPath: hit.absPath, url: hit.url, mimeType: hit.mimeType, discard: () => this.run(hit.rollbackRef) };
    });
    return {
      cacheImage: params => put(params, 'image', params.staging === true),
      cacheMedia: params => put(params, 'av', true),
      getCachedImage: (integration, token, options) => this.run(async () => {
        guard(); const hit = await cache.integrationCacheGet(integrationCacheKey(integration, token), this.db!); guard();
        if (!hit || options?.shouldReuse?.() === false) return null;
        await pinBlob(hit.hash, this.db!); guard();
        return { absPath: hit.absPath, url: hit.url, mimeType: hit.mimeType };
      }),
      resolveMediaUrl: url => {
        guard();
        try { return url.startsWith('cindy-media://') ? this.resolveMediaUrl(url).absPath : url.startsWith('xdt-image://') ? this.resolveLegacyImageUrl(url).absPath : null; }
        catch { return null; }
      },
      fetchRemoteImage,
    };
  }
  /** Import only this task's workdir/native scratchpad. New refs are recorded as
   * tool output; a stale task rolls back only the pins created by this import. */
  materializeTaskImages(scope: SessionImageScope, text: string, guard: () => void, assertTaskCurrent: () => Promise<void>): Promise<string> {
    if (!hasLocalTaskImages(text)) return Promise.resolve(text);
    return this.run(async () => {
      const newRefs: string[] = [];
      try {
        guard(); await assertTaskCurrent();
        const roots = await taskImageRoots(scope);
        guard();
        const result = await materializeTaskImageMarkdown(text, { importImage: async source => {
          const image = await readTaskImage(source, roots);
          guard(); await assertTaskCurrent(); guard();
          const saved = await this.ingestOwned({ sessionId: scope.id, bytes: image.buffer, mimeType: image.mimeType, originKind: 'tool' }, guard, newRefs);
          return saved.managedUrl!;
        } });
        await assertTaskCurrent(); guard();
        return result.text;
      } catch {
        for (const id of newRefs) await removeRefById(id, this.db!);
        return text;
      }
    });
  }
  channelImages(params: Parameters<typeof materializeLocalMarkdownImages>[0], materialize: (sessionId: string, text: string) => Promise<string>) {
    return materializeLocalMarkdownImages(params, { realpath, stat, readFile, materialize, resolveMediaUrl: url => url.startsWith('cindy-media://') ? this.resolveMediaUrl(url) : this.resolveLegacyImageUrl(url) });
  }
  async resolveManaged(url:string,sessionId?:string):Promise<AttachmentResolution> {
    await this.ready;await this.operations;const resolved=this.store.resolveSafe(url);
    if(sessionId&&!await sessionCanRead(resolved.hash,sessionId,this.db!))throw new Error('MEDIA_SESSION_ACCESS_DENIED');
    if(!await getBlobInfo(resolved.hash,this.db!))throw new Error('MEDIA_NOT_FOUND');
    const info=await lstat(resolved.absPath);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('MEDIA_NOT_FOUND');
    const root=await realpath(path.join(this.profileDir,'cindy-media','blobs'));const actual=await realpath(resolved.absPath);const relative=path.relative(root,actual);
    if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new Error('UNSAFE_MEDIA_PATH');
    return {path:resolved.absPath,managedUrl:url,mimeType:resolved.mimeType};
  }
  removeSession(id:string):Promise<void>{return this.run(async()=>{await removeRefs({refKind:'session-attachment',refId:id},this.db!);});}
  supportedMime(mime:string){return this.store.supportedMime(mime);}
  private cardDb(){return drizzle(this.native!,{schema:{ghostCards}});}
  savePluginCard(row:GhostCardRow,guard:()=>void){return this.run(async()=>{guard();await pluginCards.upsertGhostCard(row,this.cardDb());});}
  getPluginCard(id:string){return this.run(()=>pluginCards.getGhostCard(id,this.cardDb()));}
  listPluginCards(id:string){return this.run(()=>pluginCards.listGhostCardsBySession(id,this.cardDb()));}
  setPluginCardHeight(id:string,height:number){return this.run(()=>pluginCards.updateGhostCardHeight(id,height,this.cardDb()));}
  savePluginMedia(input:{ghostId:string;buffer:Uint8Array;mimeType:string;label?:string;assertStillValid?:()=>void},guard:()=>void) {
    return this.run(async()=>{
      const check=()=>{guard();input.assertStillValid?.();};check();
      const written=await this.store.writeBlob({buffer:input.buffer,mimeType:input.mimeType,assertStillValid:check});check();
      this.native!.exec('BEGIN IMMEDIATE');
      try {
        await recordBlob({...written,isCache:false},this.db!);check();
        if(!await hasRef({hash:written.hash,refKind:'ghost-gallery',refId:input.ghostId},this.db!))await addRef({hash:written.hash,refKind:'ghost-gallery',refId:input.ghostId,originKind:'ghost',originId:input.ghostId,label:input.label},this.db!);
        check();this.native!.exec('COMMIT');
      }catch(error){this.native!.exec('ROLLBACK');throw error;}
      return {url:written.url,hash:written.hash,ext:written.ext};
    });
  }
  relocatePlugin(from:string,to:string,guard:()=>void){
    return this.run(async()=>{
      guard();this.native!.exec('BEGIN IMMEDIATE');
      try{
        this.native!.prepare("UPDATE media_refs SET ref_id=? WHERE ref_id=? AND ref_kind IN ('ghost-gallery','ghost-grant','ghost-tool-grant')").run(to,from);
        this.native!.prepare("UPDATE media_refs SET origin_id=? WHERE origin_kind='ghost' AND origin_id=?").run(to,from);
        await pluginCards.reassignGhostCards(from,to,this.cardDb());guard();this.native!.exec('COMMIT');
      }catch(error){this.native!.exec('ROLLBACK');throw error;}
    });
  }
  async preparePluginAttachment(url:string,sessionId:string,guard:()=>void){
    const resolved=await this.resolveManaged(url,sessionId);guard();
    const {hash}=this.store.resolveSafe(url);
    const user=await hasRef({hash,refKind:'session-attachment',refId:sessionId,originKind:'user'},this.db!);guard();
    const bytes=await readBoundedFileNoFollow(resolved.path,GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE,{nonBlocking:true,containWithin:await realpath(path.join(this.profileDir,'cindy-media','blobs'))});guard();
    if(!bytes)throw new Error('MEDIA_NOT_FOUND');
    return {bytes:Buffer.from(bytes),mimeType:resolved.mimeType!,originKind:user?'user' as const:'tool' as const};
  }
  grantPluginAttachments(instance:string,sources:Array<{bytes:Buffer;mimeType:string;originKind:'user'|'tool'}>,guard:()=>void){
    return this.run(async()=>{
      const written=[];
      for(const source of sources){guard();written.push({...await this.store.writeBlob({buffer:source.bytes,mimeType:source.mimeType,assertStillValid:guard}),originKind:source.originKind});}
      guard();this.native!.exec('BEGIN IMMEDIATE');
      try{
        for(const item of written){
          await recordBlob({...item,isCache:false},this.db!);guard();
          await addRef({hash:item.hash,refKind:item.originKind==='user'?'ghost-grant':'ghost-tool-grant',refId:instance,originKind:item.originKind},this.db!);guard();
        }
        this.native!.exec('COMMIT');return written.map(item=>item.hash);
      }catch(error){this.native!.exec('ROLLBACK');throw error;}
    });
  }
  async readPluginMedia(instance:string,hash:string,guard:()=>void) {
    await this.ready;await this.operations;guard();
    if(!await ghostCanRead(hash,instance,this.db!))return null;
    const info=await getBlobInfo(hash,this.db!);if(!info)return null;
    const resolved=await this.resolveManaged(`cindy-media://blobs/${hash}${info.ext}`);guard();
    const root=await realpath(path.join(this.profileDir,'cindy-media','blobs'));guard();
    const buffer=await readBoundedFileNoFollow(resolved.path,Math.min(info.bytes,GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE),{nonBlocking:true,containWithin:root});guard();
    if(!buffer||buffer.length!==info.bytes)return null;
    return {buffer,mimeType:info.mimeType,ext:info.ext};
  }
  async close(){await this.ready;await this.operations;this.native?.close();}
}
