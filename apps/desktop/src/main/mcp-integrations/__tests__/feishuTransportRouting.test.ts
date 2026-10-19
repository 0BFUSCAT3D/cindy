import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbClient, type DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import type { FeishuToolTransport } from '../../im/shared/channelToolScope.js';
import { createFeishuTransportResolver } from '../feishuTransportRouting.js';
import { beginAppSessionBoundary, commitVolatileAppSession } from '../../appSessionState.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({ read: () => ({ activeMode: 'signed-out' }) }),
}));

// #6439: exercise the production resolver through DbClient -> Drizzle proxy ->
// worker_threads -> SQLite. The former pure selector never queried the DB.
// Minimal failure: one canonical link, no inbound lease; unit, one in-memory worker.
let client: DbClient;
const personal = { getOwnerOpenId: () => 'ou_personal' } as FeishuToolTransport;
const companion = { getOwnerOpenId: () => 'ou_companion' } as FeishuToolTransport;
const lane = { getOwnerOpenId: () => 'ou_lane' } as FeishuToolTransport;
const readTurnScope = vi.fn<() => { im: FeishuToolTransport } | null>(() => null);
const getCompanionTransport = vi.fn((): FeishuToolTransport | null => companion);
const resolve = createFeishuTransportResolver({ readTurnScope, getCompanionTransport, personalIm: personal });

beforeAll(async () => {
  client = await createDbClient({ transport: 'worker-thread', useInlineWorker: true });
  await client.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT)');
  await client.exec('CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, role TEXT)');
  await client.exec("INSERT INTO sessions VALUES ('canonical', 'bot'), ('desktop', 'desktop'), ('late', 'bot')");
  await client.exec("INSERT INTO bot_session_links VALUES ('canonical', 'bot-a', 'canonical')");
});
beforeEach(() => {
  commitVolatileAppSession('cloud', 'account-a');
  setCurrentDbClient(client, 'account-a');
  readTurnScope.mockReturnValue(null);
  getCompanionTransport.mockReturnValue(companion);
});
afterAll(async () => {
  commitVolatileAppSession('signed-out');
  clearCurrentDbClient(client);
  await client.dispose();
});

describe('Feishu transport with worker database', () => {
  it('resolves a canonical companion without an inbound scope', async () => {
    const { im } = await resolve({ sessionId: 'canonical' });
    expect(im.getOwnerOpenId()).toBe('ou_companion');
  });

  it('keeps inbound scope ahead of DB lookup and ordinary desktop notifications on personal bot', async () => {
    expect((await resolve({ sessionId: 'desktop' })).im).toBe(personal);
    clearCurrentDbClient(client);
    readTurnScope.mockReturnValue({ im: lane });
    expect((await resolve({ sessionId: 'canonical' })).im).toBe(lane);
  });

  it('sees canonical ownership established after an earlier lookup', async () => {
    expect((await resolve({ sessionId: 'late' })).im).toBe(personal);
    await client.exec("INSERT INTO bot_session_links VALUES ('late', 'bot-a', 'canonical')");
    expect((await resolve({ sessionId: 'late' })).im).toBe(companion);
  });

  it('never falls back to personal credentials when a companion is unavailable', async () => {
    getCompanionTransport.mockReturnValue(null);
    await expect(resolve({ sessionId: 'canonical' })).rejects.toThrow('Companion Feishu connection unavailable');
  });

  it('rejects a lookup that completes across an account switch', async () => {
    const pending = resolve({ sessionId: 'canonical' });
    setCurrentDbClient(client, 'account-b');
    await expect(pending).rejects.toThrow('Feishu account changed');
  });

  // PR #6443: teardown marks a boundary pending before replacing the worker DB.
  // Existing snapshot-switch coverage misses this reachable window (unit tier).
  it('rejects notifications while teardown is pending, including an in-flight worker lookup', async () => {
    const pending = resolve({ sessionId: 'canonical' });
    const release = beginAppSessionBoundary();
    try {
      await expect(pending).rejects.toThrow('Feishu account changed');
      await expect(resolve({ sessionId: 'canonical' })).rejects.toThrow('Feishu account changed');
    } finally {
      release();
    }
  });

  it('rejects an owner generation change even while the DB snapshot remains unchanged', async () => {
    const pending = resolve({ sessionId: 'canonical' });
    commitVolatileAppSession('cloud', 'account-a', true);
    await expect(pending).rejects.toThrow('Feishu account changed');
  });

  it('propagates asynchronous database failure instead of caching a missing owner', async () => {
    await client.exec('ALTER TABLE bot_session_links RENAME TO unavailable_links');
    try {
      await expect(resolve({ sessionId: 'canonical' })).rejects.toThrow();
    } finally {
      await client.exec('ALTER TABLE unavailable_links RENAME TO bot_session_links');
    }
    expect((await resolve({ sessionId: 'canonical' })).im).toBe(companion);
  });
});
