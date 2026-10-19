/** #6412: unit coverage of the native delivery entry, real blob/ledger/journal and restart recovery.
 * Existing materializer tests do not cross transport ACK, durable publication or owner/clear fences.
 * Real main-process translations also cover the misplaced locale namespace reported on PR #6420.
 * The native generator and message writer are boundaries; retries never receive a generator API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AgentEvent, GeneratedImageEventData } from '@cindy/maker-core';
import type { DbClient } from '../../localDb/client/DbClient';
import * as schema from '../../localDb/schema';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import { setMainLocale } from '../../i18n';
import { createGeneratedImageDelivery } from '../generatedImageDelivery';
import {
  captureGeneratedImageStorage,
  handleGeneratedImageArtifacts,
  prepareGeneratedImageTransport,
} from '../generatedImageStorage';
import { generatedImageId } from '../generatedImageJournal';
import { resolveSafe } from '../blobStore';

const state = vi.hoisted(() => ({
  root: '',
  generation: 1,
  failResult: false,
  beforeResult: undefined as (() => void) | undefined,
  insert: undefined as ((sessionId: string, body: Record<string, unknown>) => void) | undefined,
  read: undefined as ((clientId: string) => { content: string; created_at: number }) | undefined,
  broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner', generation: state.generation }),
  isAppSessionBoundaryPending: () => false,
  activeOwnerScopeKey: () => `owner:${state.generation}`,
  dataOwnerStorageKey: () => 'a'.repeat(20),
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(state.root, 'owners', 'a'.repeat(20), ...parts),
}));
vi.mock('../../device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({}) }));
vi.mock('../../localDb/ipc/messages', () => ({
  broadcastMessageRow: state.broadcast,
  createMessage: async (
    sid: string,
    body: Record<string, unknown>,
    options: { beforePublish(): Promise<void> },
  ) => {
    if (body.role === 'tool_result') {
      state.beforeResult?.();
      if (state.failResult) throw new Error('disk unavailable');
    }
    await options.beforePublish();
    state.insert!(sid, body);
    const row = state.read!(body.clientId as string);
    return {
      ...body,
      id: body.clientId,
      sessionId: sid,
      content: JSON.parse(row.content),
      createdAt: new Date(row.created_at).toISOString(),
    };
  },
}));

const image: GeneratedImageEventData = {
  kind: 'generation',
  threadId: 'thread',
  turnId: 'turn',
  blockId: 'image',
  status: 'completed',
};
const id = generatedImageId(image);
const event = (data: Partial<GeneratedImageEventData> = {}): AgentEvent => ({
  type: 'image',
  source: 'codex',
  data: { ...image, ...data },
});
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);
let raw: Database.Database;
beforeEach(async () => {
  setMainLocale('en');
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-image-'));
  state.generation = 1;
  state.failResult = false;
  state.beforeResult = undefined;
  state.broadcast.mockClear();
  raw = new Database(':memory:');
  raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, cleared_at INTEGER, agent_device_id TEXT, remote_host_id TEXT, working_dir TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT, content TEXT, rewind_at INTEGER, created_at INTEGER, UNIQUE(session_id, client_id));
    INSERT INTO sessions VALUES ('task', 'active', NULL, NULL, NULL, NULL);`);
  raw.exec(
    await fs.readFile(
      path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
      'utf8',
    ),
  );
  raw.exec('ALTER TABLE media_refs ADD COLUMN label TEXT');
  const client = {
    drizzle: drizzle(raw, { schema }),
    exec: async (sql: string, params: unknown[]) => raw.prepare(sql).run(...params),
    queryOne: async (sql: string, params: unknown[]) => raw.prepare(sql).get(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'owner');
  state.insert = (sid, body) =>
    raw
      .prepare('INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(
        body.clientId,
        sid,
        body.clientId,
        body.role,
        JSON.stringify(body.content),
        body.createdAt,
      );
  state.read = (clientId) =>
    raw.prepare('SELECT content, created_at FROM messages WHERE client_id = ?').get(clientId) as {
      content: string;
      created_at: number;
    };
});
afterEach(async () => {
  clearCurrentDbClient();
  raw.close();
  await fs.rm(state.root, { recursive: true, force: true });
});

function controller() {
  const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[]) => {
    const request = args[0] as Parameters<typeof handleGeneratedImageArtifacts>[1];
    return {
      ok: true,
      result:
        request.op === 'images'
          ? await handleGeneratedImageArtifacts('host-task', request)
          : { imageRecovery: true },
    };
  });
  const publish = vi.fn();
  return { ...createGeneratedImageDelivery({ invoke, publish }), invoke, publish };
}
function result() {
  const row = raw.prepare("SELECT content FROM messages WHERE role = 'tool_result'").get() as {
    content: string;
  };
  return JSON.parse(JSON.parse(row.content));
}

describe('native image delivery', () => {
  it('delivers bytes ahead of an unrelated remote path, persists one result and one attachment on duplicate completion', async () => {
    const host = controller();
    await Promise.all([
      host.deliver(
        'task',
        event({
          data: png.toString('base64'),
          path: '/linux/missing.png',
          pathOrigin: 'remote-agent',
        }),
      ),
      host.deliver('task', event({ data: png.toString('base64') })),
    ]);
    await host.deliver('task', event({ data: png.toString('base64') }));
    expect(result()).toMatchObject({ ok: true, native_image_delivery: { id, state: 'stored' } });
    expect(result().text).toBe('Image delivered');
    expect(await fs.readFile(resolveSafe(result().xdt_image_url).absPath)).toEqual(png);
    expect(raw.prepare('SELECT * FROM messages').all()).toHaveLength(2);
    expect(raw.prepare('SELECT ref_kind FROM media_refs').all()).toEqual([
      { ref_kind: 'session-attachment' },
    ]);
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('recovers a source-only file after native file deletion and controller restart, then releases the source pin', async () => {
    const file = path.join(state.root, 'native.png');
    const large = Buffer.concat([png, Buffer.alloc(3_200_000)]);
    await fs.writeFile(file, large);
    const transported = await prepareGeneratedImageTransport(
      'remote:host-task',
      event({ path: file }),
    );
    expect(transported.data).not.toHaveProperty('path');
    expect((transported.data as GeneratedImageEventData).url).toMatch(/^data:image\/png;base64,/);
    await fs.unlink(file);
    raw.exec("UPDATE sessions SET agent_device_id = 'source'");
    // The event was ACKed but never reached the controller's durable writer.
    const restarted = controller();
    await restarted.recover('task');
    expect(result().ok).toBe(true);
    expect((await fs.readFile(resolveSafe(result().xdt_image_url).absPath)).equals(large)).toBe(
      true,
    );
    expect(
      restarted.invoke.mock.calls.filter(
        (call) => (call[2][0] as { action?: string }).action === 'read',
      ).length,
    ).toBeGreaterThan(1);
    expect((await captureGeneratedImageStorage().journal.read('remote:host-task', id))?.state).toBe(
      'released',
    );
    expect(raw.prepare('SELECT ref_kind FROM media_refs').all()).toEqual([
      { ref_kind: 'session-attachment' },
    ]);
  });

  it('keeps paid bytes across a message-writer failure and retries the same artifact without source access', async () => {
    state.failResult = true;
    await expect(
      controller().deliver('task', event({ data: png.toString('base64') })),
    ).rejects.toThrow('disk unavailable');
    expect((await captureGeneratedImageStorage().journal.read('task:task', id))?.state).toBe(
      'failed',
    );
    state.failResult = false;
    const restarted = controller();
    await restarted.recover('task', id);
    expect(result().ok).toBe(true);
    expect(restarted.invoke).not.toHaveBeenCalled();
  });

  it('persists a delivery failure separately from native generation success without interpreting a remote path locally', async () => {
    const file = path.join(state.root, 'native.png');
    await fs.writeFile(file, png);
    const readSource = vi.fn(async () => ({ buffer: png, mimeType: 'image/png' }));
    const host = createGeneratedImageDelivery({ invoke: vi.fn(), publish: vi.fn(), readSource });
    await host.deliver('task', event({ path: file, pathOrigin: 'remote-agent' }));
    expect(readSource).not.toHaveBeenCalled();
    expect(result()).toMatchObject({
      ok: false,
      text: 'Image delivery failed. Retry transferring the existing image.',
      generation_status: 'completed',
      native_image_delivery: { state: 'failed', errorCode: 'REMOTE_SOURCE_REQUIRED' },
    });
    expect(raw.prepare('SELECT * FROM media_blobs').all()).toHaveLength(0);
  });

  it.each(['clear', 'delete', 'owner'])(
    'does not publish after %s during delivery',
    async (boundary) => {
      state.beforeResult = () => {
        if (boundary === 'owner') state.generation++;
        else
          raw.exec(
            boundary === 'clear'
              ? 'UPDATE sessions SET cleared_at = 10'
              : "UPDATE sessions SET status = 'deleted'",
          );
      };
      const host = controller();
      if (boundary === 'owner')
        await expect(host.deliver('task', event({ data: png.toString('base64') }))).rejects.toThrow(
          'SCOPE_CHANGED',
        );
      else await host.deliver('task', event({ data: png.toString('base64') }));
      expect(raw.prepare("SELECT * FROM messages WHERE role = 'tool_result'").all()).toHaveLength(
        0,
      );
      expect(host.publish).not.toHaveBeenCalled();
      expect(state.broadcast).not.toHaveBeenCalled();
      if (boundary !== 'owner')
        expect(raw.prepare('SELECT * FROM media_refs').all()).toHaveLength(0);
    },
  );

  it('keeps the generation origin when the task changes its SSH location before retry', async () => {
    raw.exec("UPDATE sessions SET remote_host_id = 'original-ssh', working_dir = '/original'");
    const readSource = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ buffer: png, mimeType: 'image/png' });
    const host = createGeneratedImageDelivery({ invoke: vi.fn(), publish: vi.fn(), readSource });
    await host.deliver('task', event({ path: '/original/image.png' }));
    const failedRow = raw
      .prepare("SELECT id, client_id AS clientId FROM messages WHERE role = 'tool_result'")
      .get() as { id: string; clientId: string };
    expect(result().native_image_delivery.state).toBe('failed');
    state.broadcast.mockClear();
    raw.exec("UPDATE sessions SET remote_host_id = NULL, working_dir = '/local'");
    await host.recover('task', id);
    expect(readSource.mock.calls.map((call) => call[2])).toEqual([
      { remoteHostId: 'original-ssh', workingDir: '/original' },
      { remoteHostId: 'original-ssh', workingDir: '/original' },
    ]);
    expect(result().ok).toBe(true);
    // #6420: maker:event alone leaves Mobile's persisted result unchanged. Reuse the row ID.
    const storedRow = state.broadcast.mock.lastCall?.[1];
    expect(storedRow).toBeDefined();
    expect(storedRow).toMatchObject({ id: failedRow.id, clientId: failedRow.clientId });
    expect(JSON.parse(storedRow.content)).toMatchObject({
      ok: true,
      xdt_image_url: result().xdt_image_url,
      native_image_delivery: { id, state: 'stored' },
    });
    expect(state.broadcast.mock.lastCall?.[2]).toBeDefined();
  });

  it('does not resurrect a removed result during retry', async () => {
    const host = controller();
    await host.deliver('task', event({ pathOrigin: 'remote-agent' }));
    raw.exec("UPDATE messages SET role = 'message_tombstone' WHERE role = 'tool_result'");
    host.publish.mockClear();
    state.broadcast.mockClear();
    await host.recover('task', id);
    expect(host.publish).not.toHaveBeenCalled();
    expect(state.broadcast).not.toHaveBeenCalled();
    expect((await captureGeneratedImageStorage().journal.read('task:task', id))?.state).toBe(
      'released',
    );
  });
});
