// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { avatarCropDrawRect, avatarOutputSize, type AvatarCrop } from '../avatarCropGeometry';
import {
  AVATAR_SOURCE_MAX_EDGE,
  avatarExportMime,
  exportAvatarCrop,
  fitAvatarSourceSize,
  hasTransparentPixel,
  type AvatarSource,
} from '../avatarCropImage';

function makeSource(width: number, height: number, mayHaveAlpha: boolean): AvatarSource {
  return {
    bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap,
    size: { width, height },
    mayHaveAlpha,
  };
}

/** 记录 drawImage 调用的最小 2D context 替身,getImageData 返回指定 alpha。 */
function stubCanvas(alpha: number) {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    data[3] = alpha;
    return { data };
  });
  const ctx = {
    drawImage,
    getImageData,
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as RenderingContext,
  );
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
  ) {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type }));
  });
  return { ctx, drawImage, getImageData, toBlob };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('avatarCropImage', () => {
  it('超大源图按长边等比缩到上限,小图原样保留', () => {
    expect(fitAvatarSourceSize({ width: 8000, height: 6000 })).toEqual({
      width: AVATAR_SOURCE_MAX_EDGE,
      height: 3072,
    });
    expect(fitAvatarSourceSize({ width: 3000, height: 9000 })).toEqual({
      width: 1365,
      height: AVATAR_SOURCE_MAX_EDGE,
    });
    const small = { width: 640, height: 480 };
    expect(fitAvatarSourceSize(small)).toBe(small);
  });

  it('透明判定:任一像素 alpha < 255 即视为透明', () => {
    expect(hasTransparentPixel(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparentPixel(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
  });

  it('导出格式:JPEG 源恒为 JPEG;PNG/WebP 源有透明像素才导出 PNG', () => {
    const opaque = new Uint8ClampedArray([0, 0, 0, 255]);
    const clear = new Uint8ClampedArray([0, 0, 0, 0]);
    expect(avatarExportMime(makeSource(10, 10, false), null)).toBe('image/jpeg');
    expect(avatarExportMime(makeSource(10, 10, true), opaque)).toBe('image/jpeg');
    expect(avatarExportMime(makeSource(10, 10, true), clear)).toBe('image/png');
  });

  it('导出把取景源矩形原样画进正方形输出画布(与编辑台同一映射,无二次裁剪 / 拉伸)', async () => {
    const { drawImage, getImageData, toBlob } = stubCanvas(255);
    const source = makeSource(4000, 3000, false);
    const crop: AvatarCrop = { cx: 1700.5, cy: 1400.25, side: 1200 };

    const result = await exportAvatarCrop(source, crop);

    const out = avatarOutputSize(crop);
    const { sx, sy, sw, sh } = avatarCropDrawRect(crop);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(source.bitmap, sx, sy, sw, sh, 0, 0, out, out);
    // JPEG 源不必逐像素判断透明。
    expect(getImageData).not.toHaveBeenCalled();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect(result.mimeType).toBe('image/jpeg');
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
  });

  it('透明 PNG 源导出 PNG,保留透明', async () => {
    const { toBlob } = stubCanvas(0);
    const result = await exportAvatarCrop(makeSource(800, 800, true), {
      cx: 400,
      cy: 400,
      side: 800,
    });
    expect(result.mimeType).toBe('image/png');
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });
});
