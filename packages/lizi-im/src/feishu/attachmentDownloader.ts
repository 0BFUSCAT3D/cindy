/**
 * feishu/attachmentDownloader.ts
 * ---------------------------------------------------------------------------
 * Take the AttachmentRef[] parsed by `incomingContent` → download via lark
 * `im.v1.messageResource.get` → 图片/音视频入 host 媒体总仓, 其余文件交 host
 * 文件暂存 → return standardised IMAttachment[] for emit upstream.
 *
 * Files larger than 30MB are dropped into `unsupported` (model + IPC can't
 * handle larger blobs sensibly). Per-attachment errors are isolated; a single
 * failed download does not block the rest.
 */

import path from 'node:path';
import type * as Lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';

import type { IMAttachment } from '../types.js';
import { getHost, getLog } from './moduleScope.js';
import { mimeFromHeaders, streamToBuffer } from './mediaStore.js';
import type {
  AttachmentRef,
  UnsupportedEntry,
} from './incomingContent.js';

/** Max bytes per attachment. Keeps parity with desktop's `MAX_FILE_SIZE`. */
export const MAX_FILE_SIZE = 30 * 1024 * 1024;

export interface DownloadResult {
  attachments: IMAttachment[];
  unsupported: UnsupportedEntry[];
}

export async function downloadAttachments(
  client: Lark.Client,
  messageId: string,
  refs: AttachmentRef[],
): Promise<DownloadResult> {
  const log = getLog();
  const attachments: IMAttachment[] = [];
  const unsupported: UnsupportedEntry[] = [];

  for (const ref of refs) {
    try {
      const one = await downloadOne(client, messageId, ref);
      if ('attachment' in one) attachments.push(one.attachment);
      else unsupported.push(one.unsupported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const label =
        ref.kind === 'file'
          ? `下载失败 ${ref.fileName}（${msg}）`
          : `图片下载失败（${msg}）`;
      log.error('[feishu/attachmentDownloader] download failed:', err);
      unsupported.push({ type: `download_failed:${ref.kind}`, label });
    }
  }

  return { attachments, unsupported };
}

type SingleResult =
  | { attachment: IMAttachment }
  | { unsupported: UnsupportedEntry };

/** host 总仓能收的图片 mime(与 cindy-media blobStore 图片白名单对齐)。 */
const HOST_CACHEABLE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * 单个附件: 图片与音视频入 cindy-media 总仓(host.media), 其余文件交 host 暂存
 * (host.files, 路由到任务后移入任务附件目录)。host 缺对应能力或总仓拒收格式时
 * 如实标不支持 —— 不写 `cc-agent/feishu-media`(冻结的历史兼容层, 只读)。
 */
async function downloadOne(
  client: Lark.Client,
  messageId: string,
  ref: AttachmentRef,
): Promise<SingleResult> {
  const host = getHost();
  const label = ref.kind === 'file' ? ref.fileName : '图片';

  if (ref.kind === 'image') {
    const media = host.media;
    if (!media) return { unsupported: { type: 'image', label } };
    try {
      const cached = await media.getCachedImage('feishu', ref.imageKey);
      if (cached) {
        return {
          attachment: {
            kind: 'image',
            absPath: cached.absPath,
            originalName: `${ref.imageKey}${path.extname(cached.absPath)}`,
            mimeType: cached.mimeType,
            url: cached.url,
          },
        };
      }
    } catch {
      // host 索引查询失败: 继续下载。
    }
    const { buffer, mimeType } = await fetchMessageResource(client, messageId, ref.imageKey, 'image');
    const oversize = oversizeEntry(label, buffer.byteLength);
    if (oversize) return { unsupported: oversize };
    const mime = mimeType.toLowerCase();
    if (!HOST_CACHEABLE_IMAGE_MIMES.has(mime)) {
      return { unsupported: { type: 'image', label: `不支持的图片格式（${mime || '未知'}）` } };
    }
    const put = await media.cacheImage({ integration: 'feishu', token: ref.imageKey, buffer, mimeType: mime });
    return {
      attachment: {
        kind: 'image',
        absPath: put.absPath,
        originalName: `${ref.imageKey}${path.extname(put.absPath)}`,
        mimeType: mime,
        url: put.url,
      },
    };
  }

  // 没有受控去处就不下载: 视频要媒体总仓, 其余文件要文件暂存。
  if (ref.video ? !host.media?.cacheMedia : !host.files) {
    return { unsupported: { type: ref.video ? 'media' : 'file', label } };
  }
  if (ref.fileSize !== undefined && ref.fileSize > MAX_FILE_SIZE) {
    return { unsupported: oversizeEntry(label, ref.fileSize)! };
  }
  const { buffer, mimeType } = await fetchMessageResource(client, messageId, ref.fileKey, 'file');
  const oversize = oversizeEntry(label, buffer.byteLength);
  if (oversize) return { unsupported: oversize };
  const mime = mimeType.toLowerCase() || 'application/octet-stream';

  if (ref.video || mime.startsWith('video/') || mime.startsWith('audio/')) {
    const cacheMedia = host.media?.cacheMedia;
    const avMime = ref.video && !mime.startsWith('video/') ? 'video/mp4' : mime;
    if (cacheMedia) {
      try {
        const stored = await cacheMedia({ integration: 'feishu', token: ref.fileKey, buffer, mimeType: avMime });
        return {
          attachment: {
            kind: 'file',
            absPath: stored.absPath,
            originalName: ref.fileName,
            mimeType: stored.mimeType,
            url: stored.url,
          },
        };
      } catch {
        // 总仓拒收该音视频格式: 视频消息标不支持; 以普通文件发来的继续按文件暂存。
      }
    }
    if (ref.video || !host.files) return { unsupported: { type: 'media', label } };
  }

  const staged = await host.files!.stage({ integration: 'feishu', buffer, fileName: ref.fileName });
  return {
    attachment: { kind: 'file', absPath: staged.absPath, originalName: ref.fileName, mimeType: mime },
  };
}

function oversizeEntry(name: string, bytes: number): UnsupportedEntry | null {
  if (bytes <= MAX_FILE_SIZE) return null;
  const sizeMb = (bytes / 1024 / 1024).toFixed(1);
  return { type: 'oversize', label: `${name} 超过 30MB（实际 ${sizeMb}MB）` };
}

async function fetchMessageResource(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = (await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  })) as unknown as {
    getReadableStream(): Readable;
    headers?: Record<string, unknown>;
  };

  const buffer = await streamToBuffer(res.getReadableStream());
  const mimeType = mimeFromHeaders(res.headers);
  return { buffer, mimeType };
}
