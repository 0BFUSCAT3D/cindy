/**
 * avatarCropImage — 头像编辑的解码与导出(依赖 Canvas / ImageBitmap,几何见 avatarCropGeometry)。
 *
 * 色彩约定(与头像 HDR→SDR 转换的整合点):
 *   - 源图只解码一次成 ImageBitmap(按 EXIF 方向转正、超大图预缩到 4096px 长边);
 *   - 编辑台与导出都把它画进**默认的 sRGB 8-bit 2D 画布**,两者走同一条绘制路径,
 *     所以编辑台显示的像素与导出的像素一致;
 *   - 导出经 canvas 重新编码成 PNG / JPEG,输出是 8-bit sRGB,不写入 gain map 等
 *     HDR 附加数据。
 * 这里**不做** HDR→SDR 色调映射:HDR 源画进 sRGB 画布时如何压缩高光由 Chromium
 * 决定(可能只是裁切),画面观感是否合格不由本模块保证。正确的色调映射由上游
 * 选图转换负责;转换后的 SDR 源交给 loadAvatarSource 即可,本模块无需改动。
 */

import {
  avatarCropDrawRect,
  avatarOutputSize,
  type AvatarCrop,
  type AvatarImageSize,
} from './avatarCropGeometry';

/** 解码后的编辑源:转正、限尺寸后的位图 + 尺寸 + 是否可能含透明。 */
export interface AvatarSource {
  bitmap: ImageBitmap;
  size: AvatarImageSize;
  /** JPEG 不可能有 alpha;PNG / WebP 需要导出时再按像素判断。 */
  mayHaveAlpha: boolean;
}

/** 导出结果:即将上传的字节本身,预览也直接用它,保证所见即所传。 */
export interface AvatarExport {
  blob: Blob;
  bytes: Uint8Array;
  mimeType: AvatarExportMime;
}

export type AvatarExportMime = 'image/png' | 'image/jpeg';

/** 解码后长边上限:4x 放大时仍有充足源像素,同时把 48MP 照片的显存压到可控范围。 */
export const AVATAR_SOURCE_MAX_EDGE = 4096;
const JPEG_QUALITY = 0.92;

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 按长边上限算缩放后的尺寸(不放大)。 */
export function fitAvatarSourceSize(size: AvatarImageSize, maxEdge = AVATAR_SOURCE_MAX_EDGE) {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return size;
  const ratio = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
  };
}

/**
 * 解码选中的图片。失败(损坏、格式不符)时抛错,由调用方提示并留在原界面。
 * 解码在切到编辑台**之前**完成,编辑台第一帧就有图,不出现空白帧。
 */
export async function loadAvatarSource(dataUrl: string): Promise<AvatarSource> {
  const blob = dataUrlToBlob(dataUrl);
  const decoded = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const natural = { width: decoded.width, height: decoded.height };
  if (natural.width === 0 || natural.height === 0) {
    decoded.close();
    throw new Error('avatar image has no pixels');
  }
  const fitted = fitAvatarSourceSize(natural);
  let bitmap = decoded;
  if (fitted !== natural) {
    bitmap = await createImageBitmap(decoded, {
      resizeWidth: fitted.width,
      resizeHeight: fitted.height,
      resizeQuality: 'high',
    });
    decoded.close();
  }
  return {
    bitmap,
    size: { width: bitmap.width, height: bitmap.height },
    mayHaveAlpha: blob.type !== 'image/jpeg',
  };
}

/** 把取景画进一块 outSize × outSize 的目标区域。编辑后预览与导出共用。 */
export function drawAvatarCrop(
  ctx: CanvasRenderingContext2D,
  source: AvatarSource,
  crop: AvatarCrop,
  outSize: number,
) {
  const { sx, sy, sw, sh } = avatarCropDrawRect(crop);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, outSize, outSize);
  ctx.drawImage(source.bitmap, sx, sy, sw, sh, 0, 0, outSize, outSize);
}

/** RGBA 像素里是否有任何非完全不透明的点。 */
export function hasTransparentPixel(rgba: Uint8ClampedArray) {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

/**
 * 透明图沿用既有约定(保留透明,导出 PNG);其余导出 JPEG,体积更小。
 */
export function avatarExportMime(source: AvatarSource, rgba: Uint8ClampedArray | null) {
  return source.mayHaveAlpha && rgba !== null && hasTransparentPixel(rgba)
    ? 'image/png'
    : 'image/jpeg';
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: AvatarExportMime): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('avatar encode failed'))),
      mime,
      mime === 'image/jpeg' ? JPEG_QUALITY : undefined,
    );
  });
}

/** 按当前取景导出最终上传的头像字节。 */
export async function exportAvatarCrop(
  source: AvatarSource,
  crop: AvatarCrop,
): Promise<AvatarExport> {
  const outSize = avatarOutputSize(crop);
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!ctx) throw new Error('avatar canvas unavailable');
  drawAvatarCrop(ctx, source, crop, outSize);
  const rgba = source.mayHaveAlpha ? ctx.getImageData(0, 0, outSize, outSize).data : null;
  const mimeType = avatarExportMime(source, rgba);
  const blob = await canvasToBlob(canvas, mimeType);
  return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}
