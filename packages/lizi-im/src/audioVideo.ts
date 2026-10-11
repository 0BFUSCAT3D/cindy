/**
 * audioVideo.ts — 入站附件「是不是音视频」的唯一判据(各渠道共用)。
 *
 * 音视频只进 host 媒体总仓(cacheMedia), 由总仓按白名单与真实字节决定收不收;
 * 进不去就标不支持, 不回落文件暂存。平台给的 MIME 经常是空或
 * `application/octet-stream`, 所以 MIME 与扩展名任一命中都算音视频。
 */

import path from 'node:path';

const AV_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
};

function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * 音视频 → 交给总仓用的 MIME(平台 MIME 已是音视频就用它, 否则按扩展名推断);
 * 不是音视频返回 null。
 */
export function audioVideoMimeOf(
  mime: string | null | undefined,
  fileName: string | null | undefined,
): string | null {
  const normalized = normalizeMime(mime);
  if (normalized.startsWith('video/') || normalized.startsWith('audio/')) return normalized;
  return AV_MIME_BY_EXT[path.extname(fileName ?? '').toLowerCase()] ?? null;
}
