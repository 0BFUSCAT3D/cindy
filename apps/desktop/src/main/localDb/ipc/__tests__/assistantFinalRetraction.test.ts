/** Late authoritative empty finals retract only the rejected draft in real SQLite. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { messages, sessions } from '../../schema';
import { tx } from '../../worker/opHandlers/tx';
import { discardPersistedAssistantMessage } from '../messages';
import * as prRefsStore from '../../../git-context/prRefsStore';
import { onAssistantTextEvent, clearSessionPersistState, drainPersistQueue,
  flushAssistantBlock } from '../../../messagePersistBroadcaster';

const h = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  client: null as {
    drizzle: ReturnType<typeof drizzle>;
    tx: (name: string, args: unknown) => Promise<unknown>;
    exec: (sql: string, params?: unknown[]) => Promise<Database.RunResult>;
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  } | null,
  broadcast: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.broadcast } }] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-media/chatAttachments', () => ({
  commitMessageMediaRefs: vi.fn(async () => null),
  collectCindyMediaHashes: vi.fn(() => []),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  removeRefs: vi.fn(async () => undefined),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../device-link/invoke-context', () => ({
  isDeviceLinkInvoke: vi.fn(() => false),
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

function setupDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
    CREATE TABLE session_pr_refs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL,
      repo TEXT NOT NULL, pr_number INTEGER NOT NULL, url TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      UNIQUE(session_id, owner, repo, pr_number)
    );
  `);
  sqlite.prepare("INSERT INTO sessions (id, cleared_at, status) VALUES ('s1', NULL, 'active')").run();
  const db = drizzle(sqlite, {
    schema: { messages, sessions },
  });
  h.sqlite = sqlite;
  h.client = {
    drizzle: db,
    tx: async (name: string, args: unknown) => tx(sqlite, { name, args }),
    exec: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).run(...params)),
    query: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params)),
  };
}


beforeEach(() => { vi.clearAllMocks(); clearSessionPersistState('s1'); setupDb(); });
afterEach(async () => { await drainPersistQueue(); clearSessionPersistState('s1'); h.sqlite?.close(); });

it('removes a flushed draft from history and broadcasts deletion while preserving the newer item', async () => {
  const first = onAssistantTextEvent('s1', { text: 'Withdrawn draft', agentMessageId: 'a' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  h.sqlite!.prepare("UPDATE sessions SET list_preview = 'Withdrawn draft', list_message_count = 1").run();
  const newer = onAssistantTextEvent('s1', { text: 'Next step', agentMessageId: 'b' }, null);
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages WHERE client_id = ?').get(first)).toEqual({ n: 0 });
  expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:deleted', {
    sessionId: 's1', clientId: first, clientIds: [first],
  });
  expect(h.sqlite!.prepare('SELECT list_preview, list_message_count FROM sessions').get())
    .toEqual({ list_preview: null, list_message_count: null });
  // Repeated final events must not recreate the rejected draft.
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT client_id, content FROM messages').all())
    .toEqual([{ client_id: newer, content: 'Next step' }]);
});

it('does not retract a different role, session, hidden row or stale boundary', async () => {
  const insert = h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
  insert.run('user', 'user', 's1', 'user', '"hello"', null);
  insert.run('other', 'other', 's2', 'assistant', '"hello"', null);
  insert.run('hidden', 'hidden', 's1', 'assistant', '"hello"', 2);
  insert.run('stale', 'stale', 's1', 'assistant', '"hello"', null);
  for (const id of ['user', 'other', 'hidden', 'missing']) {
    expect(await discardPersistedAssistantMessage('s1', id, () => true)).toBe(false);
  }
  let checks = 0;
  expect(await discardPersistedAssistantMessage('s1', 'stale', () => ++checks === 1)).toBe(false);
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 4 });
});

it('keeps a row changed while the exact-row rollback was being queued', async () => {
  h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('a', 'a', 's1', 'assistant', ?, 1)").run(JSON.stringify('draft'));
  const original = h.client!.tx;
  h.client!.tx = async (name, args) => {
    h.sqlite!.prepare("UPDATE messages SET content = ? WHERE client_id = 'a'").run(JSON.stringify('edited'));
    return original(name, args);
  };
  expect(await discardPersistedAssistantMessage('s1', 'a', () => true)).toBe(false);
  expect(h.sqlite!.prepare('SELECT content FROM messages').get()).toEqual({ content: '"edited"' });
});


it('removes the withdrawn draft PR reference but retains a surviving message reference', async () => {
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
  flushAssistantBlock('s1');
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber).sort()).toEqual([1, 2]);
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber)).toEqual([1]);
});

it('orders retraction cleanup after the original asynchronous PR publication hook', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const original = prRefsStore.recordPrRefsForMessage;
  const hook = vi.spyOn(prRefsStore, 'recordPrRefsForMessage').mockImplementationOnce(async (msg) => {
    await pending;
    await original(msg);
  });
  let retracted!: () => void;
  const rollback = new Promise<void>((resolve) => { retracted = resolve; });
  const originalTx = h.client!.tx;
  h.client!.tx = async (name, args) => {
    const result = await originalTx(name, args);
    if ((args as { publication?: string }).publication === 'rollback') retracted();
    return result;
  };
  try {
    onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    expect(hook).toHaveBeenCalledTimes(1);
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
    await rollback;
    release();
    await drainPersistQueue();
    await pending;
    // Await the hook itself too, so a late stale write cannot hide behind the assertion.
    await hook.mock.results[0].value;
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
  } finally { release(); hook.mockRestore(); }
});
