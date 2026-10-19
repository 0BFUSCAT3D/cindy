import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { AgentIslandCompanionSnapshot } from '../../shared/agentIsland.js';
import { botAvatarInitial, normalizeBotAvatarHue } from '../../shared/botAvatarHue.js';
import { BOT_AVATAR_MAX_BYTES, isManagedBotAvatarUrl, isSingleBotAvatarGrapheme } from '../../shared/botAvatarValue.js';
import { resolveSafe } from '../cindy-media/blobStore.js';
import { getDbClient } from '../localDb/client/current.js';
import { botGroups, botProfiles, botSessionLinks } from '../localDb/schema.js';
import { encodeNotificationAvatar } from '../notificationAvatar.js';

export interface AgentIslandCompanionIdentity {
  botId: string;
  companion: AgentIslandCompanionSnapshot;
}

/** Links that speak as the companion; delegated executions stay ordinary tasks. */
const COMPANION_SPEAKING_ROLES = ['canonical', 'history', 'group', 'channel'] as const;

/** Bundled preset artwork, relative to the packaged resources directory. */
const PRESET_AVATAR_FILES: Readonly<Record<string, string>> = {
  'cindy://avatar/preset/cindy': 'companion-preset-avatars/cindy.png',
  'cindy://avatar/preset/dash': 'legacy-teammate-avatars/dash.png',
  'cindy://avatar/preset/lizi': 'legacy-teammate-avatars/lizi.png',
};

const THUMBNAIL_CACHE_LIMIT = 32;
// Content-addressed avatar values: a changed avatar is a new key, never a stale hit.
const thumbnails = new Map<string, Promise<string | undefined>>();

/** The companion a Bot Session speaks for, or null for every other Session. */
export async function readAgentIslandCompanion(sessionId: string): Promise<AgentIslandCompanionIdentity | null> {
  const db = getDbClient().drizzle;
  const row = await db
    .select({
      botId: botProfiles.id,
      name: botProfiles.displayName,
      avatar: botProfiles.avatar,
      avatarColor: botProfiles.avatarColor,
      role: botSessionLinks.role,
      routeKey: botSessionLinks.routeKey,
    })
    .from(botSessionLinks)
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(
      eq(botSessionLinks.sessionId, sessionId),
      inArray(botSessionLinks.role, [...COMPANION_SPEAKING_ROLES]),
    ))
    .get();
  if (!row) return null;
  const groupId = row.role === 'group' && row.routeKey?.startsWith('group:') ? row.routeKey.slice('group:'.length) : null;
  const group = groupId
    ? await db.select({ name: botGroups.name }).from(botGroups).where(eq(botGroups.id, groupId)).get()
    : undefined;
  const avatar = row.avatar.trim();
  const emoji = isSingleBotAvatarGrapheme(avatar) ? avatar : null;
  const imageJpeg = emoji ? undefined : await avatarThumbnail(avatar);
  const groupName = group?.name.trim();
  return {
    botId: row.botId,
    companion: {
      name: row.name,
      ...(groupName ? { groupName } : {}),
      hue: normalizeBotAvatarHue(row.avatarColor),
      ...(imageJpeg ? { imageJpeg } : {}),
      glyph: emoji ?? botAvatarInitial(row.name),
      glyphIsInitial: !emoji,
    },
  };
}

function avatarThumbnail(avatar: string): Promise<string | undefined> {
  const cached = thumbnails.get(avatar);
  if (cached) return cached;
  const pending = encodeAvatarThumbnail(avatar).catch(() => undefined);
  thumbnails.set(avatar, pending);
  if (thumbnails.size > THUMBNAIL_CACHE_LIMIT) thumbnails.delete(thumbnails.keys().next().value!);
  // Artwork is optional: a failed read falls back to the glyph and retries on the next lookup.
  void pending.then((value) => { if (!value && thumbnails.get(avatar) === pending) thumbnails.delete(avatar); });
  return pending;
}

async function encodeAvatarThumbnail(avatar: string): Promise<string | undefined> {
  const bytes = await readAvatarBytes(avatar);
  if (!bytes) return undefined;
  const encoded = await encodeNotificationAvatar(bytes, sharp);
  return encoded?.kind === 'jpeg' ? encoded.value : undefined;
}

async function readAvatarBytes(avatar: string): Promise<Buffer | undefined> {
  const preset = PRESET_AVATAR_FILES[avatar.toLowerCase()];
  if (preset) {
    const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    return readFile(path.join(root, preset));
  }
  if (!isManagedBotAvatarUrl(avatar)) return undefined;
  const bytes = await readFile(resolveSafe(avatar).absPath);
  return bytes.length > BOT_AVATAR_MAX_BYTES ? undefined : bytes;
}
