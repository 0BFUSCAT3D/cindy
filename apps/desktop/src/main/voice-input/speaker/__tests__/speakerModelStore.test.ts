import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tiny stand-ins for the real 28 MB models; the store only cares about size and name.
vi.mock('@cindy/voice-input-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/voice-input-core')>();
  const assets = [
    { role: 'vad', fileName: 'vad.onnx', sha256: 'a'.repeat(64), bytes: 8 },
    { role: 'embedding', fileName: 'embed.onnx', sha256: 'b'.repeat(64), bytes: 16 },
  ] as const;
  return {
    ...actual,
    SPEAKER_MODEL_ASSETS: assets,
    SPEAKER_MODEL_TOTAL_BYTES: 24,
    speakerModelAsset: (role: string) => assets.find((asset) => asset.role === role),
  };
});

const { SpeakerModelStore } = await import('../speakerModelStore');
const { DownloadError } = await import('../../../downloader');

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-models-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type DownloadCall = { url: string; targetPath: string; expectedSize?: number; sha256?: string };

function fakeDownload(calls: DownloadCall[], fail?: (call: DownloadCall) => Error | undefined) {
  return vi.fn(async (options: DownloadCall & { onProgress?: (event: { loaded: number }) => void }) => {
    calls.push(options);
    const error = fail?.(options);
    if (error) throw error;
    options.onProgress?.({ loaded: options.expectedSize ?? 0 });
    fs.writeFileSync(options.targetPath, Buffer.alloc(options.expectedSize ?? 0));
    return { path: options.targetPath, size: options.expectedSize ?? 0, sha256: options.sha256 ?? '', fromCache: false };
  });
}

function createStore(download: ReturnType<typeof fakeDownload>, cdn = 'https://cdn.example.com/') {
  return new SpeakerModelStore({
    dir: () => dir,
    cdnBaseUrl: () => cdn,
    download: download as never,
  });
}

describe('SpeakerModelStore', () => {
  it('reports missing until every model is on disk, then ready', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls));
    expect(store.getModelPaths()).toBeNull();
    expect(store.getState().modelState).toBe('missing');

    await store.ensureDownloaded();

    expect(calls.map((call) => call.url)).toEqual([
      `https://cdn.example.com/voice-models/${'a'.repeat(64)}.onnx`,
      `https://cdn.example.com/voice-models/${'b'.repeat(64)}.onnx`,
    ]);
    expect(calls.every((call) => call.sha256 && call.expectedSize)).toBe(true);
    expect(store.getState()).toMatchObject({ modelState: 'ready', downloadedBytes: 24, totalBytes: 24 });
    expect(store.getModelPaths()).toEqual({
      vadModel: path.join(dir, `${'a'.repeat(16)}-vad.onnx`),
      embeddingModel: path.join(dir, `${'b'.repeat(16)}-embed.onnx`),
    });
  });

  it('joins a running download instead of starting another', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls));
    await Promise.all([store.ensureDownloaded(), store.ensureDownloaded()]);
    expect(calls).toHaveLength(2);
  });

  it('skips models already present and removes files of older versions', async () => {
    fs.writeFileSync(path.join(dir, `${'a'.repeat(16)}-vad.onnx`), Buffer.alloc(8));
    fs.writeFileSync(path.join(dir, 'old-model.onnx'), 'stale');
    const calls: DownloadCall[] = [];
    await createStore(fakeDownload(calls)).ensureDownloaded();
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'old-model.onnx'))).toBe(false);
  });

  it('classifies a checksum failure and allows a retry', async () => {
    const calls: DownloadCall[] = [];
    let failOnce = true;
    const store = createStore(
      fakeDownload(calls, () => {
        if (!failOnce) return undefined;
        failOnce = false;
        return new DownloadError('CHECKSUM', 'mismatch');
      }),
    );
    await expect(store.ensureDownloaded()).rejects.toThrow('mismatch');
    expect(store.getState()).toMatchObject({ modelState: 'failed', downloadError: 'checksum' });

    await store.ensureDownloaded();
    expect(store.getState().modelState).toBe('ready');
  });

  it('treats a user cancel as missing, not failed', async () => {
    const store = createStore(fakeDownload([], () => new DownloadError('ABORTED', 'aborted')));
    await expect(store.ensureDownloaded()).rejects.toThrow();
    expect(store.getState()).toMatchObject({ modelState: 'missing' });
    expect(store.getState().downloadError).toBeUndefined();
  });

  it('refuses a CDN base that is not https', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls), '');
    await expect(store.ensureDownloaded()).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(store.getState()).toMatchObject({ modelState: 'failed', downloadError: 'unavailable' });
  });
});
