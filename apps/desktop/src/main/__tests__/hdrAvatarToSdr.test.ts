/**
 * hdrAvatarToSdr 单测:用 macOS ImageIO 真实编码的 HDR 夹具(PQ / HLG PNG、PQ JPEG、
 * ISO 21496-1 增益图 JPEG,来源见 fixtures/hdr-avatar/make-hdr-avatar-fixtures.swift)
 * 跑真实 sharp 转换,并对输出字节逐项断言:不再携带 HDR 信号,且像素确为 SDR 色调映射
 * 结果。夹具场景为线性光水平渐变 0 → 8×SDR 白(x / 255 × 8),上半中性、下半暖色。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { readIccCicp, readPngHdrChunks, toSdrAvatarImage } from '../hdrAvatarToSdr';

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', 'hdr-avatar', name));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}
/** 在 IHDR 之后插入块(IHDR 固定占 8 + 25 字节)。 */
function insertAfterIhdr(png: Buffer, ...chunks: Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}
function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    types.push(png.toString('latin1', offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

const PQ = (nits: number) => {
  const m1 = 2610 / 16384,
    m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096,
    c2 = (2413 / 4096) * 32,
    c3 = (2392 / 4096) * 32;
  const y = Math.pow(nits / 10_000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
};

/** 16-bit RGBA PQ(BT.709 原色)PNG,仅靠 cICP 块声明 HDR,不带 ICC。 */
async function syntheticPqPng(
  pixels: Array<{ nits: [number, number, number]; alpha: number }>,
  options: { cicp?: [number, number, number, number]; cllNits?: number; orientation?: number } = {},
) {
  const raw = new Uint16Array(pixels.length * 4);
  pixels.forEach(({ nits, alpha }, index) => {
    raw.set([...nits.map((value) => Math.round(PQ(value) * 65535)), alpha], index * 4);
  });
  let encoder = sharp(raw, { raw: { width: pixels.length, height: 1, channels: 4 } }).toColourspace(
    'rgb16',
  );
  if (options.orientation) encoder = encoder.withMetadata({ orientation: options.orientation });
  const png = await encoder.png().toBuffer();
  const extra = [pngChunk('cICP', Buffer.from(options.cicp ?? [1, 16, 0, 1]))];
  if (options.cllNits) {
    const clli = Buffer.alloc(8);
    clli.writeUInt32BE(options.cllNits * 10_000, 0);
    extra.push(pngChunk('cLLI', clli));
  }
  return insertAfterIhdr(png, ...extra);
}

/** Apple HDR gain map 结构:SDR 主图后经 MPF 追加一张带 hdrgainmap XMP 的辅助图。 */
async function appleGainMapJpeg(width: number, height: number): Promise<Buffer> {
  const primary = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const xmp = Buffer.from(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description apdi:AuxiliaryImageType="urn:com:apple:photo:2020:aux:hdrgainmap"/></x:xmpmeta>',
    'latin1',
  );
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(xmp.length + 2, 2);
  const auxiliary = await sharp(Buffer.alloc(8 * 8 * 3, 90), {
    raw: { width: 8, height: 8, channels: 3 },
  })
    .jpeg()
    .toBuffer();
  const secondary = Buffer.concat([auxiliary.subarray(0, 2), app1, xmp, auxiliary.subarray(2)]);
  return Buffer.concat([primary, secondary]);
}

async function rgbaAt(buffer: Buffer, xs: number[], y = 0) {
  const { data, info } = await sharp(buffer)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return xs.map((x) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)]);
}

/** 输出必须是 8-bit、无 HDR 信号(ICC cicp / PNG cICP / 增益图签名)的普通 SDR 图。 */
async function expectNoHdrSignal(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata();
  expect(metadata.depth).toBe('uchar');
  expect(metadata.gainMap).toBeUndefined();
  expect(readIccCicp(metadata.icc)?.transfer ?? 0).not.toBeOneOf([16, 18]);
  if (metadata.format === 'png') expect(readPngHdrChunks(buffer).cicp).toBeNull();
  for (const signature of ['urn:iso:std:iso:ts:21496:-1', 'hdr-gain-map', 'aux:hdrgainmap']) {
    expect(buffer.includes(signature)).toBe(false);
  }
  return metadata;
}

// 夹具渐变上的采样列与其场景线性值:0, 0.25, 0.5, 1.0(SDR 白), 4.0, 8.0。
const RAMP_XS = [0, 8, 16, 32, 128, 255];

describe('toSdrAvatarImage — PQ / HLG', () => {
  it.each([
    ['pq-bt2100.png', 'image/png', 16],
    ['hlg-bt2100.png', 'image/png', 18],
    ['pq-bt2100.jpg', 'image/jpeg', 16],
  ])('%s is tone mapped to 8-bit sRGB without HDR signalling', async (name, mimeType, transfer) => {
    const input = fixture(name);
    const inputMetadata = await sharp(input).metadata();
    expect(readIccCicp(inputMetadata.icc)?.transfer).toBe(transfer);

    const output = await toSdrAvatarImage({ buffer: input, mimeType });
    expect(output.mimeType).toBe(mimeType);
    const metadata = await expectNoHdrSignal(output.buffer);
    expect(metadata.hasProfile).toBe(false);
    expect([metadata.width, metadata.height]).toEqual([inputMetadata.width, inputMetadata.height]);

    const neutral = (await rgbaAt(output.buffer, RAMP_XS, 10)).map(([r]) => r!);
    // 中间调与 macOS 自身 SDR 渲染(sdr-display-p3.png:0.25 → 137, 0.5 → 188)一致;
    // SDR 白保持接近白而不是被整体压暗;高光平滑滚降到 255 而非按 PQ 码值显示成灰色。
    expect(neutral[0]).toBeLessThanOrEqual(2);
    expect(Math.abs(neutral[1]! - 137)).toBeLessThanOrEqual(3);
    expect(Math.abs(neutral[2]! - 188)).toBeLessThanOrEqual(3);
    expect(neutral[3]).toBeGreaterThanOrEqual(238);
    expect(neutral[3]).toBeLessThan(250);
    expect(neutral[5]).toBeGreaterThanOrEqual(252);
    for (let index = 1; index < neutral.length; index++) {
      expect(neutral[index]).toBeGreaterThanOrEqual(neutral[index - 1]! - 1);
    }
    // 暖色行在 SDR 白处保持 R > G > B 的色相(线性 1 : 0.6 : 0.3)。
    const [, , , [r, g, b]] = await rgbaAt(output.buffer, RAMP_XS, 100);
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
    expect(Math.abs(g! - 194)).toBeLessThanOrEqual(8);
  });

  it('reads cICP-only PNGs, honours cLLI, and keeps transparency', async () => {
    const pixels = [
      { nits: [203, 203, 203] as [number, number, number], alpha: 65535 },
      { nits: [600, 600, 600] as [number, number, number], alpha: 32768 },
      { nits: [50, 10, 2] as [number, number, number], alpha: 0 },
    ];
    const input = await syntheticPqPng(pixels);
    expect(pngChunkTypes(input)).toContain('cICP');
    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/png' });
    await expectNoHdrSignal(output.buffer);
    expect(pngChunkTypes(output.buffer)).not.toContain('cICP');
    const [white, bright, dim] = await rgbaAt(output.buffer, [0, 1, 2]);
    expect(white![3]).toBe(255);
    expect(bright![3]).toBe(128);
    expect(dim![3]).toBe(0);
    expect(white![0]).toBeGreaterThanOrEqual(238);
    expect(bright![0]).toBeGreaterThan(white![0]!);

    // 声明的内容峰值更高时,同样 600 nit 会被压得更多(更暗)。
    const brighterMaster = await toSdrAvatarImage({
      buffer: await syntheticPqPng(pixels, { cllNits: 4000 }),
      mimeType: 'image/png',
    });
    const [, brightUnderHigherPeak] = await rgbaAt(brighterMaster.buffer, [0, 1, 2]);
    expect(brightUnderHigherPeak![0]).toBeLessThan(bright![0]!);
  });

  it('bakes EXIF orientation into converted pixels', async () => {
    const input = await syntheticPqPng(
      [
        { nits: [203, 0, 0], alpha: 65535 },
        { nits: [0, 0, 203], alpha: 65535 },
      ],
      { orientation: 6 },
    );
    expect((await sharp(input).metadata()).orientation).toBe(6);
    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/png' });
    const metadata = await sharp(output.buffer).metadata();
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([1, 2, undefined]);
    const [[top], [bottom]] = [
      await rgbaAt(output.buffer, [0], 0),
      await rgbaAt(output.buffer, [0], 1),
    ];
    // Orientation 6 = 顺时针 90°:原来最左的红色像素到顶部。
    expect(top![0]).toBeGreaterThan(200);
    expect(bottom![2]).toBeGreaterThan(200);
  });

  it('converts WebP whose ICC profile declares PQ', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hdr-avatar-'));
    try {
      const iccPath = path.join(dir, 'pq.icc');
      await writeFile(iccPath, (await sharp(fixture('pq-bt2100.png')).metadata()).icc!);
      const input = await sharp(Buffer.alloc(16 * 16 * 3, 200), {
        raw: { width: 16, height: 16, channels: 3 },
      })
        .withIccProfile(iccPath)
        .webp({ quality: 95 })
        .toBuffer();
      expect(readIccCicp((await sharp(input).metadata()).icc)?.transfer).toBe(16);
      const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/webp' });
      expect(output.mimeType).toBe('image/webp');
      expect((await expectNoHdrSignal(output.buffer)).hasProfile).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects HDR sources whose declared dimensions exceed the limit before decoding', async () => {
    const png = await syntheticPqPng([{ nits: [203, 203, 203], alpha: 65535 }]);
    // 改写 IHDR 宽高为 10000 × 10000(1 亿像素),文件仍只有几百字节。
    const ihdr = Buffer.from(png.subarray(16, 29));
    ihdr.writeUInt32BE(10_000, 0);
    ihdr.writeUInt32BE(10_000, 4);
    const inflated = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), png.subarray(33)]);
    expect((await sharp(inflated).metadata()).width).toBe(10_000);
    await expect(toSdrAvatarImage({ buffer: inflated, mimeType: 'image/png' })).rejects.toThrow(
      /INVALID_PARAMS.*dimensions exceed/,
    );
  });

  it('rejects HDR bytes it cannot decode instead of storing them unchanged', async () => {
    const valid = await syntheticPqPng([{ nits: [203, 203, 203], alpha: 65535 }]);
    const truncated = valid.subarray(0, valid.length - 20);
    await expect(toSdrAvatarImage({ buffer: truncated, mimeType: 'image/png' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });
});

describe('toSdrAvatarImage — gain maps', () => {
  it('drops an ISO 21496-1 gain map and keeps the SDR base rendition', async () => {
    const input = fixture('iso-gainmap.jpg');
    const inputMetadata = await sharp(input).metadata();
    expect(inputMetadata.gainMap).toBeDefined();
    expect(input.includes('urn:iso:std:iso:ts:21496:-1')).toBe(true);

    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/jpeg' });
    expect(output.mimeType).toBe('image/jpeg');
    const metadata = await expectNoHdrSignal(output.buffer);
    // 主图的 Display P3 ICC 原样保留,SDR 颜色不被改写。
    expect(metadata.icc?.equals(inputMetadata.icc!)).toBe(true);
    expect([metadata.width, metadata.height]).toEqual([inputMetadata.width, inputMetadata.height]);
    const before = await rgbaAt(input, RAMP_XS, 100);
    const after = await rgbaAt(output.buffer, RAMP_XS, 100);
    after.forEach((pixel, index) => {
      pixel.slice(0, 3).forEach((value, channel) => {
        expect(Math.abs(value - before[index]![channel]!)).toBeLessThanOrEqual(6);
      });
    });
  });

  it('strips Apple HDR gain map auxiliary images appended through MPF', async () => {
    const input = await appleGainMapJpeg(8, 8);
    const output = await toSdrAvatarImage({ buffer: input, mimeType: 'image/jpeg' });
    await expectNoHdrSignal(output.buffer);
    expect(output.buffer.length).toBeLessThan(input.length);
    expect(
      (await rgbaAt(output.buffer, [4], 4))[0]!.slice(0, 3).every((v) => Math.abs(v - 90) <= 3),
    ).toBe(true);
  });

  it('downscales large gain-map photos like the PQ / HLG path', async () => {
    // 4200 × 4100 ≈ 1722 万像素,超过 4096²。
    const output = await toSdrAvatarImage({
      buffer: await appleGainMapJpeg(4200, 4100),
      mimeType: 'image/jpeg',
    });
    const metadata = await expectNoHdrSignal(output.buffer);
    expect(metadata.width! * metadata.height!).toBeLessThanOrEqual(4096 * 4096);
    expect(Math.abs(metadata.width! / metadata.height! - 4200 / 4100)).toBeLessThan(0.01);
  });
});

describe('toSdrAvatarImage — SDR passthrough', () => {
  it('returns SDR inputs byte-for-byte, including wide-gamut and 16-bit PNG', async () => {
    const sdrP3 = fixture('sdr-display-p3.png');
    // ImageIO 自身的 SDR 渲染:16-bit、Display P3、cICP 声明 sRGB 传递函数(13)。
    expect(readPngHdrChunks(sdrP3).cicp).toMatchObject({ primaries: 12, transfer: 13 });
    const oriented = await sharp(Buffer.alloc(4 * 2 * 3, 120), {
      raw: { width: 4, height: 2, channels: 3 },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const transparentWebp = await sharp(Buffer.alloc(4 * 4 * 4, 80), {
      raw: { width: 4, height: 4, channels: 4 },
    })
      .webp()
      .toBuffer();
    for (const [buffer, mimeType] of [
      [sdrP3, 'image/png'],
      [oriented, 'image/jpeg'],
      [transparentWebp, 'image/webp'],
    ] as const) {
      const image = { buffer, mimeType };
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });

  it('passes through bytes it cannot parse, preserving the existing validation behaviour', async () => {
    for (const buffer of [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('not an image'),
    ]) {
      const image = { buffer, mimeType: 'image/png' };
      expect(await toSdrAvatarImage(image)).toBe(image);
    }
  });
});
