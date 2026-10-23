import { createChatMedia as createSharedChatMedia } from '@cindy/companion-core/chatMedia';
import { chatErrorDiagnostic } from './chatServerErrors.js';
import { retryAfterDeadline } from '@cindy/auth-client';
import { net } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFile as readMedia, supportedMime } from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { getDbClient } from '../localDb/client/current.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { botGroupAttachmentsPath } from './botGroupWorkDir.js';
import { safeAttachmentFileName } from './botGroupAttachments.js';
import type { ChatApi } from './chatServerMigration.js';
export function createChatMedia(api:ChatApi,current:()=>boolean,log?:{warn(message:string,meta?:Record<string,unknown>):void},options:{allowLoopback?:boolean}={}) {
 return createSharedChatMedia(api,current,{
  fetch:(...args)=>net.fetch(...args),retryAfterDeadline,diagnostic:chatErrorDiagnostic,
  read:async(attachment,maxSize,check)=>{if(attachment.path){const stat=await fs.stat(attachment.path);check();if(!stat.isFile()||stat.size>maxSize)throw new Error('ATTACHMENT_TOO_LARGE');}return attachment.url?.startsWith('cindy-media://')?(await readMedia(attachment.url)).buffer:attachment.path?await fs.readFile(attachment.path):null;},
  cache:async({roomId,mediaId,name,mimeType,size,buffer},check)=>{const root=ownerScopedUserDataPath();const db=getDbClient().drizzle;const base={id:mediaId,name,mimeType,size};if(mimeType.startsWith('image/')&&supportedMime(mimeType)){const stored=await ingestMedia({buffer,mimeType,isCache:true,refs:[],assertStillValid:check},db);return {...base,category:'image',url:stored.url,path:null};}const dir=path.join(botGroupAttachmentsPath(root,roomId),mediaId);await fs.mkdir(dir,{recursive:true});check();const file=path.join(dir,safeAttachmentFileName(name));await fs.writeFile(file,buffer);check();return {...base,category:'file',url:null,path:file};}
 },log,options);
}
