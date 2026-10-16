import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LedgerDb } from '../../cindy-media/ledger';

const state = vi.hoisted(() => ({
  root: '',
  owner: 'alice',
  generation: 1,
  db: undefined as LedgerDb | undefined,
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: state.owner }),
}));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: state.db }) }));
vi.mock('../broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => state.generation,
  isDataOwnerBroadcastScopeCurrent: (generation: number) => generation === state.generation,
}));

import * as schema from '../../localDb/schema';
import { listAllBlobRecords, listCacheBlobsByLru } from '../../cindy-media/ledger';
import { resolveHashRef } from '../../cindy-media/blobStore';
import {
  invalidateRemoteMediaPersistentWrites,
  remoteMediaPersistentCache,
} from '../remoteMediaPersistentCache';
import { remoteFileVersionCache } from '../remoteFileVersionCache';

const { default: migration0071 } =
  (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
    default: { run: (db: Database.Database) => void };
  };
let raw: Database.Database;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const url = `cindy-media://blobs/${createHash('sha256').update(png).digest('hex')}.png`;
function reopen() {
  raw = new Database(path.join(state.root, 'ledger.db'));
  raw.pragma('foreign_keys = ON');
  state.db = drizzle(raw, { schema }) as unknown as LedgerDb;
}
beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-image-cache-'));
  state.owner = 'alice';
  state.generation = 1;
  reopen();
  const sql = await fs.readFile(
    path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
    'utf8',
  );
  for (const statement of sql.split('--> statement-breakpoint'))
    if (statement.trim()) raw.exec(statement);
  migration0071.run(raw);
});
afterEach(async () => {
  raw.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

it('reuses image bytes after closing and reopening the database, across login generations', async () => {
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  raw.close();
  state.generation++;
  reopen();
  const cached = await remoteMediaPersistentCache('computer', url)!.get(1024);
  expect(cached?.bytes).toEqual(png);
  expect((await listCacheBlobsByLru(state.db, 'remote-media')).length).toBe(1);
});

it('direct transfers and preview downloads share one persistent index and cleanup category', async () => {
  const direct = remoteFileVersionCache('computer', url, {
    version: 'b'.repeat(64),
    size: png.length,
    mimeType: 'image/png',
  })!;
  await direct.put(png);
  expect((await remoteMediaPersistentCache('computer', url)!.get(1024))?.bytes).toEqual(png);
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  expect(await listCacheBlobsByLru(state.db, 'remote-file')).toEqual([]);
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toHaveLength(1);
  expect(await direct.get()).not.toBeNull();
});

it('isolates device, account and original URL even when their bytes are identical', async () => {
  await remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  expect(await remoteMediaPersistentCache('other-computer', url)!.get(1024)).toBeNull();
  expect(
    await remoteMediaPersistentCache('computer', 'xdt-image://history/image.png')!.get(1024),
  ).toBeNull();
  state.owner = 'bob';
  state.generation++;
  expect(await remoteMediaPersistentCache('computer', url)!.get(1024)).toBeNull();
});

it('detects a corrupt local file and refuses oversized cache reads', async () => {
  const cache = remoteMediaPersistentCache('computer', url)!;
  await cache.put(png, 'image/png');
  expect(await cache.get(1)).toBeNull();
  const [record] = await listAllBlobRecords(state.db);
  const file = resolveHashRef(record.hash, record.ext).absPath;
  await fs.writeFile(file, Buffer.alloc(png.length));
  expect(await cache.get(1024)).toBeNull();
  const direct = remoteFileVersionCache('computer', url, {
    version: 'b'.repeat(64), size: png.length, mimeType: 'image/png',
  })!;
  expect(await direct.get()).toBeNull();
  await direct.put(png);
  expect(await direct.get()).toBe(file);
  expect((await cache.get(1024))?.bytes).toEqual(png);
  await fs.rm(file);
  expect(await cache.get(1024)).toBeNull();
});

it('does not persist arbitrary paths, false image MIME, or mismatched content addresses', async () => {
  expect(remoteMediaPersistentCache('computer', 'xdt-file://local/?path=/image.png')).toBeNull();
  await remoteMediaPersistentCache('computer', url)!.put(Buffer.from('not an image'), 'image/png');
  await remoteMediaPersistentCache('computer', `cindy-media://blobs/${'a'.repeat(64)}.png`)!.put(
    png,
    'image/png',
  );
  expect(await listAllBlobRecords(state.db)).toEqual([]);
});

it('drops a late write after account switching without adding a cache index', async () => {
  const pending = remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  state.owner = 'bob';
  state.generation++;
  await expect(pending).rejects.toThrow('FILE_PEER_CANCELLED');
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});

it('does not refill a cache that was cleared during its background write', async () => {
  const pending = remoteMediaPersistentCache('computer', url)!.put(png, 'image/png');
  invalidateRemoteMediaPersistentWrites();
  await expect(pending).rejects.toThrow('REMOTE_MEDIA_CACHE_CLEARED');
  expect(await listCacheBlobsByLru(state.db, 'remote-media')).toEqual([]);
});
