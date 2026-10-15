/**
 * 群聊附件的 renderer 侧转换（docs/product-rules/bot-group-chat.md §3.1）。
 *
 * 托盘沿用普通聊天的 `useAttachments`：图片照常缓存进媒体总仓（`cindy-media://`），
 * 其余文件就地用本机路径。`useAttachments` 只在有 scope 时才走缓存（否则落内存
 * base64，main 会拒收），而 main 的图片缓存并不按 scope 落盘——所以给每个群一个
 * 稳定、不会与真实任务 id 撞上的 scope，同时用作输入框草稿键。
 */
import type { JSONContent } from '@tiptap/core';
import { serializeAttachedFiles } from '@/lib/messageAttachmentPayload';
import type { AttachedFile } from '@/lib/fileTypes';
import type { BotGroupAttachment, BotGroupAttachmentInput } from '../../../shared/botGroupChat';

/** Attachment cache scope and composer draft key of one group (never a task id). */
export function botGroupAttachmentScope(groupId: string): string {
  return `bot-group:${groupId}`;
}

/** Draft key of a 话题's reply box; text only (thread replies carry no attachments). */
export function botGroupThreadDraftKey(groupId: string, rootId: string): string {
  return `${botGroupAttachmentScope(groupId)}:thread:${rootId}`;
}

/**
 * The group composer is a plain textarea, so its draft text is stored in the shared draft
 * store as one paragraph per line — a document the store understands (draft presence, owner
 * scoping) and that reads back to exactly the same text.
 */
export function botGroupDraftDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}

export function botGroupDraftText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const textOf = (node: JSONContent): string =>
    node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(textOf).join('');
  return (doc.content ?? []).map(textOf).join('\n');
}

/** A tray file as the optimistic copy of a message shows it before main has it. */
export function botGroupAttachmentPreview(file: AttachedFile): BotGroupAttachment {
  return {
    id: file.id,
    name: file.name,
    category: file.category,
    mimeType: file.mimeType,
    size: file.size,
    url: file.url ?? null,
    path: file.path || null,
  };
}

/** The tray's files in the shape `sendBotGroupMessage` takes. */
export function toBotGroupAttachmentInputs(files: readonly AttachedFile[]): BotGroupAttachmentInput[] {
  return (serializeAttachedFiles(files) ?? []).map((file) => ({
    id: file.id,
    name: file.name,
    path: file.path,
    ext: file.ext,
    size: file.size,
    category: file.category,
    mimeType: file.mimeType,
    ...(file.url ? { url: file.url } : {}),
    ...(file.originalName ? { originalName: file.originalName } : {}),
    ...(file.annotated ? { annotated: true } : {}),
  }));
}

/**
 * What the send's idempotency key covers besides the text: the same files with the
 * same annotations. Anything else is a different message and gets a new clientId.
 */
export function botGroupAttachmentSignature(files: readonly AttachedFile[]): string {
  return JSON.stringify(
    files.map((file) => [file.id, file.url ?? file.path, file.annotationStrokes ?? null]),
  );
}

/** A sent message's images (shown as pictures) and other files (shown as chips). */
export function splitBotGroupMessageAttachments(attachments: readonly BotGroupAttachment[]): {
  images: Array<BotGroupAttachment & { url: string }>;
  files: Array<BotGroupAttachment & { path: string }>;
} {
  const images: Array<BotGroupAttachment & { url: string }> = [];
  const files: Array<BotGroupAttachment & { path: string }> = [];
  for (const attachment of attachments) {
    const { url, path } = attachment;
    if (attachment.category === 'image' && url) images.push({ ...attachment, url });
    else if (path) files.push({ ...attachment, path });
  }
  return { images, files };
}
