import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  trusted: vi.fn(),
  ingest: vi.fn(),
  current: true,
  db: {},
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.trusted,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: mocks.ingest }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'owner-a:1' }),
  isDataOwnerBroadcastScopeCurrent: () => mocks.current,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: mocks.db }) }));
import { disposeHtmlPreviews, registerHtmlPreviewIpc } from '../html-preview-ipc';
import { readPreviewMetadata } from '../html-preview-read';
const args = {
  origin: { kind: 'device', deviceId: 'remote' },
  workdir: '/remote',
  absPath: '/remote/preview/index.html',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = true;
});
afterAll(disposeHtmlPreviews);
it('bounds concurrent preparations before allocating more snapshots', async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerHtmlPreviewIpc({
    stat: async () => {
      await paused;
      throw new Error('offline');
    },
    read: vi.fn(),
  });
  const open = mocks.handle.mock.calls[0][1];
  const settled = Promise.allSettled(Array.from({ length: 8 }, () => open({}, args)));
  await expect(open({}, args)).rejects.toMatchObject({ code: 'HTML_PREVIEW_TOO_LARGE' });
  release();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
});
it('rejects an untrusted guest before any filesystem or remote operation', async () => {
  mocks.trusted.mockImplementationOnce(() => {
    throw new Error('PERMISSION_DENIED');
  });
  const stat = vi.fn();
  registerHtmlPreviewIpc({ stat, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toThrow('PERMISSION_DENIED');
  expect(stat).not.toHaveBeenCalled();
});
it('returns an actionable typed error when the remote cannot read files', async () => {
  const stat = vi.fn().mockRejectedValue(new Error('METHOD_NOT_FOUND'));
  registerHtmlPreviewIpc({ stat, read: vi.fn() });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).rejects.toMatchObject({
    code: 'HTML_PREVIEW_UNSUPPORTED',
  });
  expect(stat).toHaveBeenCalledExactlyOnceWith(args, '/remote/preview', 'index.html', expect.any(AbortSignal));
});

// Unit tier, fake clock: the real metadata reader must survive transient
// congestion without retrying permanent errors or allowing unbounded waiting.
it('backs off read-only metadata across congestion and a short disconnect', async () => {
  vi.useFakeTimers();
  try {
    const stat = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'BACKPRESSURE' }))
      .mockRejectedValueOnce(new Error('[NOT_CONNECTED] reconnecting'))
      .mockResolvedValue({ type: 'file' });
    const result = readPreviewMetadata(stat, new AbortController().signal, () => true);
    await vi.advanceTimersByTimeAsync(999);
    expect(stat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ type: 'file' });
    expect(stat).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

it.each(['BACKPRESSURE', 'INVOKE_TIMEOUT', 'NOT_CONNECTED'])('bounds repeated %s failures and preserves the connection error', async (code) => {
  vi.useFakeTimers();
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stat = vi.fn().mockImplementation(async () => {
      started();
      throw Object.assign(new Error('transient'), { code });
    });
    registerHtmlPreviewIpc({ stat, read: vi.fn() });
    const result = mocks.handle.mock.calls[0][1]({}, args).catch((e: unknown) => e);
    await ready;
    await vi.advanceTimersByTimeAsync(7_000);
    const expected = { BACKPRESSURE: 'DEVICE_LINK_BUSY', INVOKE_TIMEOUT: 'DEVICE_LINK_TIMEOUT', NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED' }[code];
    expect(await result).toMatchObject({ code: expected });
    expect(stat).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

it('ends a stalled stat at the total deadline and aborts its downstream signal', async () => {
  vi.useFakeTimers();
  try {
    const stat = vi.fn(() => new Promise(() => {}));
    const result = readPreviewMetadata(stat, new AbortController().signal, () => true).catch(e => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'DEVICE_LINK_TIMEOUT' });
    expect(stat).toHaveBeenCalledOnce();
    expect((stat.mock.calls[0] as unknown as [AbortSignal])[0].aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(['cancel', 'owner-change'] as const)('does not start another read after %s during backoff', async (cause) => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    let current = true;
    const stat = vi.fn().mockRejectedValue(new Error('[BACKPRESSURE] busy'));
    const result = readPreviewMetadata(stat, controller.signal, () => current).catch(e => e);
    await vi.advanceTimersByTimeAsync(100);
    if (cause === 'cancel') controller.abort();
    else current = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: 'HTML_PREVIEW_CANCELLED' });
    expect(stat).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(['cancel', 'destroyed', 'navigation'] as const)('cancels pending metadata on %s and discards its late success', async (trigger) => {
  let resolve!: (value: { relPath: string; type: 'file'; size: number; mtimeMs: number }) => void;
  let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  let signal!: AbortSignal;
  const stat = vi.fn((_args, _root, _rel, attemptSignal) => {
    signal = attemptSignal;
    started();
    return new Promise<{ relPath: string; type: 'file'; size: number; mtimeMs: number }>(done => { resolve = done; });
  });
  registerHtmlPreviewIpc({ stat, read: vi.fn() });
  const open = mocks.handle.mock.calls[0][1];
  const cancel = mocks.handle.mock.calls[1][1];
  const sender = Object.assign(new EventEmitter(), { id: 10 });
  const result = open({ sender }, { ...args, requestId: 'preview-1' }).catch((e: unknown) => e);
  await ready;
  // A trusted but different window cannot cancel this sender's allocation.
  await cancel({ sender: { id: 11 } }, 'preview-1');
  expect(signal.aborted).toBe(false);
  if (trigger === 'cancel') await cancel({ sender }, 'preview-1');
  else if (trigger === 'destroyed') sender.emit('destroyed');
  else sender.emit('did-start-navigation', {}, 'https://example.test', false, true);
  expect(await result).toMatchObject({ code: 'HTML_PREVIEW_CANCELLED' });
  expect(signal.aborted).toBe(true);
  resolve({ relPath: 'index.html', type: 'file', size: 0, mtimeMs: 0 });
  await Promise.resolve();
  expect(stat).toHaveBeenCalledOnce();
  expect(sender.listenerCount('destroyed')).toBe(0);
  expect(sender.listenerCount('did-start-navigation')).toBe(0);
});
it('opens a preview before downloading even a large entry file', async () => {
  const read = vi.fn();
  registerHtmlPreviewIpc({
    stat: async () => ({
        name: 'index.html',
        relPath: 'index.html',
        type: 'file',
        size: 101 * 1024 * 1024,
        mtimeMs: 0,
    }),
    read,
  });
  await expect(mocks.handle.mock.calls[0][1]({}, args)).resolves.toMatchObject({ ok: true });
  expect(read).not.toHaveBeenCalled();
});
it('passes the captured owner guard through reference-free cache ingestion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-owner-test-'));
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await fs.writeFile(path.join(dir, 'image.png'), png);
    mocks.ingest.mockImplementationOnce(async (params, db) => {
      expect(db).toBe(mocks.db);
      expect(params.refs).toEqual([]);
      expect(params.isCache).toBe(true);
      params.assertStillValid();
      // The real ingest helper calls this guard after each asynchronous write/ref operation.
      await Promise.resolve();
      mocks.current = false;
      params.assertStillValid();
    });
    registerHtmlPreviewIpc({
      stat: async (_args, _root, name) => ({
          name,
          relPath: name,
          type: 'file' as const,
          size: name === 'image.png' ? png.length : 0,
          mtimeMs: 0,
        }),
      read: async (_args, _root, entry) => path.join(dir, entry.relPath),
    });
    const { url } = await mocks.handle.mock.calls[0][1]({}, args);
    expect((await readResource(url, '/image.png')).status).toBe(502);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('serves independent media after cache loss without refs across failure and retries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-ref-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '');
    await fs.writeFile(path.join(dir, 'image.png'), png);
    let fail = true;
    mocks.ingest.mockImplementation(async (params) => {
      expect(params.refs).toEqual([]);
      expect(params.isCache).toBe(true);
      if (fail) { fail = false; throw new Error('cache write failed'); }
      // A reclaimed managed blob is deliberately unavailable; HTTP must use dest.
      return { url: 'cindy-media://blobs/unavailable.png', refIds: [] };
    });
    registerHtmlPreviewIpc({
      stat: async (_args, _root, name) => ({
        name, relPath: name, type: 'file' as const,
        size: name === 'image.png' ? png.length : 0, mtimeMs: 0,
      }),
      read: async (_args, _root, entry) => path.join(dir, entry.relPath),
    });
    const open = mocks.handle.mock.calls[0][1];
    const failed = await open({}, args);
    expect((await readResource(failed.url, '/image.png')).status).toBe(502);
    for (let i = 0; i < 3; i++) {
      const { url } = await open({}, args);
      const bootstrap = await fetch(url, { redirect: 'manual' });
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
      await bootstrap.body?.cancel();
      const response = await fetch(new URL('/image.png', url), { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    }
    expect(mocks.ingest).toHaveBeenCalledTimes(4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('opens beyond eight sequential snapshots by reclaiming the oldest completed one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-preview-capacity-test-'));
  try {
    const source = path.join(dir, 'index.html');
    await fs.writeFile(source, '');
    registerHtmlPreviewIpc({
      stat: async () => ({ relPath: 'index.html', type: 'file', size: 0, mtimeMs: 0 }),
      read: async () => source,
    });
    const open = mocks.handle.mock.calls[0][1];
    const urls: string[] = [];
    for (let i = 0; i < 12; i++) urls.push((await open({}, args)).url);
    await expect(fetch(urls[0])).rejects.toThrow();
    for (const url of urls.slice(-8)) {
      const response = await fetch(url, { redirect: 'manual' });
      expect(response.status).toBe(302);
      await response.body?.cancel();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function readResource(url: string, pathname: string) {
  const bootstrap = await fetch(url, { redirect: 'manual' });
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  await bootstrap.body?.cancel();
  return fetch(new URL(pathname, url), { headers: { cookie } });
}
