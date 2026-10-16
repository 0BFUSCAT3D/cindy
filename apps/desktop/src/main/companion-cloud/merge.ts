/**
 * Merging the copies of Cindy that grew on separate computers into one companion
 * (cloud-companions.md, 2026-10-16 裁决 2). Runs on the kept Cindy's home: the other copies'
 * memories, own skills, todos, routines, workbench and conversation join it; their profile does
 * not (the kept one is the user's chosen base). Nothing is overwritten silently: a memory or skill
 * that exists on both sides with different content is kept as a second, renamed entry. The merged
 * copies are then retired in the cloud; their own data stays there and on their computers.
 * Every step is idempotent, so a failed merge is simply run again.
 */
import { createHash } from 'node:crypto';
import { inferBotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import type { CompanionHistoryAttachment, CompanionMaterializeHost, CompanionWriteFence } from './materialize.js';
import type { CompanionMediaUpload, CompanionMirrorAttachment } from './mirror.js';
import { readAllRoomMessages } from './room.js';
import type { CompanionApi, CompanionLog } from './types.js';
import {
  COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_ROUTINE_PREFIX, COMPANION_SKILL_PREFIX, COMPANION_TODO_PREFIX,
  COMPANION_WORKBENCH_KEY,
} from './uploader.js';

export interface CompanionMergeActor {
  id: string; externalId: string; name: string; homeDeviceId?: string | null;
  /** Where it came from (its computer's name), for naming a second copy of a same-name memory or skill. */
  label?: string;
}

export interface CompanionMergeSummary {
  merged: number;
  messages: number;
  memories: number;
  skills: number;
  /** Memories and skills that existed on both sides with different content, kept under these names. */
  renamed: string[];
}

type PrefRow = { key: string; value: unknown; revision: number };

/** Copies of Cindy: made from the Cindy preset, or the provisioned default Cindy. Never by name. */
export function isCindyCompanion(externalId: string, profile: unknown): boolean {
  if (externalId === 'cindy-default') return true;
  const value = profile && typeof profile === 'object' ? profile as { templateId?: unknown; soul?: unknown } : {};
  if (value.templateId === 'cindy') return true;
  return typeof value.soul === 'string' && inferBotTemplatePresetId(value.soul) === 'cindy';
}

const BATCH = 50;
const BATCH_BYTES = 200_000;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** `name.md` → `name-<suffix>.md`; skills are slugs without an extension. */
export function renamedEntry(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  const safe = suffix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'merged';
  return dot > 0 ? `${name.slice(0, dot)}-${safe}${name.slice(dot)}` : `${name}-${safe}`;
}

export async function mergeCompanionsInto(input: {
  api: CompanionApi;
  host: Pick<CompanionMaterializeHost, 'readMemory' | 'restoreMemory' | 'readSkill' | 'saveSkill' | 'applyTodos' | 'applyRoutines' | 'applyWorkbench'>;
  keep: CompanionMergeActor;
  from: CompanionMergeActor[];
  humanActorId: string;
  /** Room of a companion (deterministic per companion actor). */
  roomOf: (actor: CompanionMergeActor) => Promise<string>;
  media?: { upload: CompanionMediaUpload; download: (roomId: string, mediaId: string) => Promise<CompanionHistoryAttachment> };
  /** After the conversation is in the kept room: bring it into the kept companion's own task. */
  importHistory: () => Promise<void>;
  fence: CompanionWriteFence;
  log?: CompanionLog;
}): Promise<CompanionMergeSummary> {
  const { api, host, keep, fence } = input;
  const summary: CompanionMergeSummary = { merged: 0, messages: 0, memories: 0, skills: 0, renamed: [] };
  const keepRoom = await input.roomOf(keep);
  for (const source of input.from) {
    fence.assertCurrent();
    const rows = await api<PrefRow[]>('/preferences', 'GET', undefined, source.id);
    const prefs = (Array.isArray(rows) ? rows : []).filter(row => row.value !== null);
    const suffix = source.label || (source.name && source.name !== keep.name ? source.name : source.externalId.slice(-8));

    for (const row of prefs.filter(candidate => candidate.key.startsWith(COMPANION_MEMORY_PREFIX))) {
      const filename = row.key.slice(COMPANION_MEMORY_PREFIX.length);
      const content = text(record(row.value)?.content);
      if (content === undefined) continue;
      const current = await host.readMemory(keep.externalId, filename);
      if (current === content) continue;
      let target = filename;
      if (current !== null) {
        target = renamedEntry(filename, suffix);
        // A second run finds the renamed copy already there.
        if (await host.readMemory(keep.externalId, target) === content) continue;
        summary.renamed.push(target);
      }
      fence.assertCurrent();
      await host.restoreMemory(keep.externalId, target, content, fence);
      summary.memories += 1;
    }

    for (const row of prefs.filter(candidate => candidate.key.startsWith(COMPANION_SKILL_PREFIX))) {
      const slug = row.key.slice(COMPANION_SKILL_PREFIX.length);
      const content = text(record(row.value)?.content);
      if (content === undefined) continue;
      const current = await host.readSkill(keep.externalId, slug);
      if (current === content) continue;
      let target = slug;
      if (current !== null) {
        target = renamedEntry(slug, suffix);
        if (await host.readSkill(keep.externalId, target) === content) continue;
        summary.renamed.push(target);
      }
      fence.assertCurrent();
      await host.saveSkill(keep.externalId, target, content, record(row.value)?.enabled !== false, fence);
      summary.skills += 1;
    }

    // Ids are unique per companion, so these join without conflicts; a rerun replaces the same ids.
    const todos = prefs.filter(row => row.key.startsWith(COMPANION_TODO_PREFIX)).map(row => row.value);
    if (todos.length && host.applyTodos) await host.applyTodos(keep.externalId, todos, [], fence);
    const routines = prefs.filter(row => row.key.startsWith(COMPANION_ROUTINE_PREFIX)).map(row => row.value);
    if (routines.length && host.applyRoutines) await host.applyRoutines(keep.externalId, routines, [], fence);
    const workbench = prefs.find(row => row.key === COMPANION_WORKBENCH_KEY);
    if (workbench && host.applyWorkbench) await host.applyWorkbench(keep.externalId, workbench.value, fence);

    summary.messages += await mergeConversation({ ...input, source, keepRoom });
    fence.assertCurrent();
    // The merged copy is no longer a companion: other computers hide and stop their copy of it.
    await api(`/actors/${source.id}`, 'PATCH', { disabled: true });
    summary.merged += 1;
  }
  await input.importHistory();
  return summary;
}

/** The source's conversation into the kept room, by message time, keeping each message's time. */
async function mergeConversation(input: {
  api: CompanionApi;
  keep: CompanionMergeActor;
  source: CompanionMergeActor;
  keepRoom: string;
  humanActorId: string;
  roomOf: (actor: CompanionMergeActor) => Promise<string>;
  media?: { upload: CompanionMediaUpload; download: (roomId: string, mediaId: string) => Promise<CompanionHistoryAttachment> };
  fence: CompanionWriteFence;
  log?: CompanionLog;
}): Promise<number> {
  const sourceRoom = await input.roomOf(input.source);
  const messages = await readAllRoomMessages(input.api, sourceRoom, input.source.id);
  const prepared: Array<{ sourceId: string; authorId: string; createdAt: string; content: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    const authorId = message.role === 'assistant' ? input.keep.id : input.humanActorId;
    const sourceId = `merge:${input.source.id}:${message.id}`;
    // Room files belong to their room: bring each over (download, upload again); a file that
    // cannot come keeps its name in the text.
    const media: Array<{ type: string; mediaId?: string; caption?: string }> = [];
    const missing: string[] = [];
    for (const file of message.attachments ?? []) {
      try {
        if (!input.media) throw new Error('MEDIA_UNAVAILABLE');
        const local = await input.media.download(sourceRoom, file.mediaId);
        const attachment: CompanionMirrorAttachment = { id: file.mediaId, name: local.name, category: local.url ? 'image' : 'file',
          mimeType: local.mimeType, size: local.size, url: local.url, path: local.path };
        media.push(...await input.media.upload(input.keepRoom, sourceId, [attachment], authorId));
      } catch (error) {
        missing.push(file.name);
        input.log?.warn('Merged attachment kept as its name', { code: error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN' });
      }
      input.fence.assertCurrent();
    }
    const body = [message.text, ...missing.map(name => `[附件: ${name}]`)].filter(Boolean).join('\n');
    prepared.push({ sourceId, authorId, createdAt: new Date(message.createdAt).toISOString(),
      content: [...(body ? [{ type: 'text', text: body }] : []), ...media] });
  }
  let imported = 0;
  let start = 0;
  while (start < prepared.length) {
    // Same limits as the mirror: at most 50 messages and about 200 KB per request.
    let end = start; let bytes = 0;
    while (end < prepared.length && end - start < BATCH) {
      const size = Buffer.byteLength(JSON.stringify(prepared[end]));
      if (end > start && bytes + size > BATCH_BYTES) break;
      bytes += size; end += 1;
    }
    const batch = prepared.slice(start, end);
    input.fence.assertCurrent();
    await input.api(`/conversations/${input.keepRoom}/import`, 'POST', {
      operationId: `companion-merge:${createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 48)}`, messages: batch });
    imported += batch.length;
    start = end;
  }
  return imported;
}

/** The profile snapshot of a companion actor, for telling the copies of Cindy apart. */
export async function readProfileSnapshot(api: CompanionApi, actorId: string): Promise<unknown> {
  const rows = await api<PrefRow[]>('/preferences', 'GET', undefined, actorId);
  return (Array.isArray(rows) ? rows : []).find(row => row.key === COMPANION_PROFILE_KEY)?.value ?? null;
}
