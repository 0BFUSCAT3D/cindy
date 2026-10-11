import path from 'node:path';

import type {
  IMAttachment,
  IMHostFileStaging,
  IMHostMediaCache,
  IMMessageEvent,
  IMUnsupportedEntry,
} from '../types.js';
import { encodeMessageId } from './codec.js';

const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024;

export interface MessageLike {
  id: string;
  content?: string | null;
  author: { id: string; username?: string; globalName?: string | null };
  channelId?: string;
  channel?: { id?: string; name?: string };
  attachments?: Iterable<AttachmentLike> | { values(): IterableIterator<AttachmentLike> };
  stickers?: Iterable<StickerLike> | { values(): IterableIterator<StickerLike> };
  type?: string | number;
}

export interface AttachmentLike {
  id?: string;
  name?: string;
  filename?: string;
  url: string;
  size: number;
  contentType?: string | null;
}

export interface StickerLike {
  id?: string;
  name?: string;
}

export async function normalizeDmMessage(
  m: MessageLike,
  ctx: {
    contextId: string;
    download: (url: string) => Promise<Uint8Array>;
    /** host 媒体总仓: 图片与音视频入内容寻址仓; 缺省时这类附件标不支持。 */
    media?: IMHostMediaCache;
    /** host 文件暂存: 非媒体文件; 缺省时标不支持。均不写 legacy 目录。 */
    files?: IMHostFileStaging;
    /** 暂存成功后的回滚句柄 — 下载期间配置换代时由调用方逐个调用。 */
    stagedDiscards?: Array<() => Promise<void>>;
  },
): Promise<IMMessageEvent | null> {
  const chatId = m.channelId ?? m.channel?.id ?? '';
  if (!chatId) {
    // Malformed event without a resolvable channel (e.g. partial presence
    // or guild event leaking through the DM filter). Return null so the
    // transport suppresses it entirely — emitting an event with an empty
    // chatId could inject non-DM content into the owner's agent session.
    return null;
  }
  const attachments: IMAttachment[] = [];
  const unsupported: IMUnsupportedEntry[] = [];

  for (const sticker of iterableValues(m.stickers)) {
    unsupported.push({ type: 'sticker', label: sticker.name ?? sticker.id ?? 'sticker' });
  }

  const messageAttachments = iterableValues(m.attachments);
  if (isVoiceMessage(m) && messageAttachments.length === 0) {
    unsupported.push({ type: 'audio', label: 'audio message' });
  }

  for (let i = 0; i < messageAttachments.length; i += 1) {
    const attachment = messageAttachments[i];
    const originalName = attachment.name ?? attachment.filename ?? attachment.id ?? 'attachment';
    const mimeType = (attachment.contentType ?? inferMimeType(originalName)).split(';')[0].trim().toLowerCase();
    // 平台附件 id 全局唯一, 缺失时退 `msgId-序号` —— host 据此免重下。
    const token = attachment.id ?? `${m.id}-${i}`;
    const destination = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('audio/') || mimeType.startsWith('video/')
        ? 'av'
        : 'file';
    const unsupportedType =
      destination === 'av' ? (mimeType.startsWith('audio/') ? 'audio' : 'video') : destination;

    if (attachment.size > MAX_INBOUND_FILE_BYTES) {
      unsupported.push({ type: 'oversize', label: originalName });
      continue;
    }
    // 没有受控去处就不下载: 图片/音视频要媒体总仓, 其余要文件暂存。
    const canStore =
      destination === 'image'
        ? Boolean(ctx.media)
        : destination === 'av'
          ? Boolean(ctx.media?.cacheMedia)
          : Boolean(ctx.files);
    if (!canStore) {
      unsupported.push({ type: unsupportedType, label: originalName });
      continue;
    }

    let buffer: Uint8Array;
    try {
      buffer = await ctx.download(attachment.url);
    } catch {
      unsupported.push({ type: 'download', label: originalName });
      continue;
    }
    try {
      if (destination === 'image') {
        const promoted = await ctx.media!.cacheImage({ integration: 'discord', token, buffer, mimeType });
        attachments.push({ kind: 'image', absPath: promoted.absPath, originalName, mimeType, url: promoted.url });
      } else if (destination === 'av') {
        const stored = await ctx.media!.cacheMedia!({ integration: 'discord', token, buffer, mimeType });
        if (stored.discard) ctx.stagedDiscards?.push(stored.discard);
        attachments.push({
          kind: 'file',
          absPath: stored.absPath,
          originalName,
          mimeType: stored.mimeType,
          url: stored.url,
        });
      } else {
        const staged = await ctx.files!.stage({ integration: 'discord', buffer, fileName: originalName });
        ctx.stagedDiscards?.push(staged.discard);
        attachments.push({ kind: 'file', absPath: staged.absPath, originalName, mimeType });
      }
    } catch {
      // host 仓拒收(白名单外格式 / 未就绪): 如实标不支持, 不降级写 legacy 目录。
      unsupported.push({ type: unsupportedType, label: originalName });
    }
  }

  return {
    channelName: 'discord',
    interactionSource: {
      chatName: m.channel?.name ?? m.author.globalName ?? m.author.username,
      senderName: m.author.globalName ?? m.author.username ?? m.author.id,
      messageUrl: `https://discord.com/channels/@me/${chatId}/${m.id}`,
    },
    senderId: m.author.id,
    chatId,
    contextId: ctx.contextId,
    messageId: encodeMessageId(chatId, m.id),
    text: m.content ?? '',
    attachments,
    unsupported,
    threadTs: undefined,
    scopeKey: undefined,
    raw: m,
  };
}

function iterableValues<T>(source: Iterable<T> | { values(): IterableIterator<T> } | undefined): T[] {
  if (!source) return [];
  if (hasValues<T>(source)) return Array.from(source.values());
  return Array.from(source);
}

function hasValues<T>(source: unknown): source is { values(): IterableIterator<T> } {
  return (
    typeof source === 'object' &&
    source !== null &&
    'values' in source &&
    typeof (source as { values?: unknown }).values === 'function'
  );
}

function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

function isVoiceMessage(m: MessageLike): boolean {
  return m.type === 'voice' || m.type === 'VoiceMessage';
}
