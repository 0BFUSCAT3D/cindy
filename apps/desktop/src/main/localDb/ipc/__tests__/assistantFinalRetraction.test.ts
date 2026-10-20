/** Late authoritative empty finals retract only the rejected draft in real SQLite. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { messages, sessions } from '../../schema';
import { tx } from '../../worker/opHandlers/tx';
import { discardPersistedAssistantMessage } from '../messages';
import * as prRefsStore from '../../../git-context/prRefsStore';
import { commitMessageMediaRefs } from '../../../cindy-media/chatAttachments';
import { onAssistantTextEvent, clearSessionPersistState, drainPersistQueue,
  flushAssistantBlock, noteSessionClearBoundary } from '../../../messagePersistBroadcaster';

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
vi.mock('../../../cindy-media/chatAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cindy-media/chatAttachments')>();
  return { ...actual, commitMessageMediaRefs: vi.fn(actual.commitMessageMediaRefs) };
});
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
    CREATE TABLE media_blobs (
      hash TEXT PRIMARY KEY, ext TEXT NOT NULL, mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL, is_cache INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL
    );
    CREATE TABLE media_refs (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES media_blobs(hash),
      ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, origin_session_id TEXT,
      origin_kind TEXT, origin_id TEXT, label TEXT, created_at INTEGER NOT NULL
    );
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


it('does not restore pre-clear PR references when retraction cleanup resumes after clear', async () => {
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
  flushAssistantBlock('s1');
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  let release!: () => void;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void;
  const snapshotTaken = new Promise<void>((resolve) => { captured = resolve; });
  const db = h.client!.drizzle;
  const select = db.select.bind(db);
  let paused = false;
  const spy = vi.spyOn(db, 'select').mockImplementation((fields) => {
    const query = select(fields);
    const from = query.from.bind(query);
    vi.spyOn(query, 'from').mockImplementation((table) => {
      const builder = from(table);
      if (table === messages && !paused) {
        const orderBy = builder.orderBy.bind(builder);
        vi.spyOn(builder, 'orderBy').mockImplementationOnce((...columns) => {
          paused = true;
          const snapshot = orderBy(...columns).all();
          captured();
          return resume.then(() => snapshot) as unknown as ReturnType<typeof orderBy>;
        });
      }
      return builder;
    });
    return query;
  });
  try {
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
    await snapshotTaken;
    const boundary = Date.now() + 1000;
    h.sqlite!.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(boundary, 's1');
    noteSessionClearBoundary('s1', boundary);
    await prRefsStore.recomputePrRefsForSession('s1');
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
    release();
    await drainPersistQueue();
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
  } finally { release(); spy.mockRestore(); }
});


it.each(['none', 'previous', 'newer'] as const)(
  'broadcasts the surviving canonical list preview after retracting the draft (%s)', async (survivor) => {
    if (survivor === 'previous') {
      h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('u', 'u', 's1', 'user', ?, 1)").run('Previous question');
    }
    onAssistantTextEvent('s1', { text: 'Rejected draft', agentMessageId: 'a' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    if (survivor === 'newer') {
      onAssistantTextEvent('s1', { text: 'Newer answer', agentMessageId: 'b' }, null);
      flushAssistantBlock('s1');
      await drainPersistQueue();
    }
    h.broadcast.mockClear();
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
    await drainPersistQueue();
    const patches = h.broadcast.mock.calls.filter(([channel]) => channel === 'local-db:sessions:patched');
    expect(patches.at(-1)?.[1]).toEqual({ sessionId: 's1', patch: {
      preview: survivor === 'none' ? null : survivor === 'previous' ? 'Previous question' : 'Newer answer',
    } });
  },
);

it.each(['Corrected without a link', 'https://github.com/o/r/pull/3'])(
  'reconciles PR references after nonempty final correction and a delayed original hook (%s)', async (text) => {
    onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = prRefsStore.recordPrRefsForMessage;
    const hook = vi.spyOn(prRefsStore, 'recordPrRefsForMessage').mockImplementationOnce(async (msg) => {
      await pending;
      await original(msg);
    });
    let corrected!: () => void;
    const written = new Promise<void>((resolve) => { corrected = resolve; });
    const originalTx = h.client!.tx;
    h.client!.tx = async (name, args) => {
      const result = await originalTx(name, args);
      if (name === 'message.updateContent') corrected();
      return result;
    };
    try {
      onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'correct' }, null);
      flushAssistantBlock('s1');
      await drainPersistQueue();
      onAssistantTextEvent('s1', { text, agentMessageId: 'correct', isFinal: true, isFullText: true }, null);
      await written;
      release();
      await drainPersistQueue();
      await hook.mock.results[0].value;
      expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber).sort())
        .toEqual(text.includes('/pull/') ? [1, 3] : [1]);
    } finally { release(); hook.mockRestore(); }
  },
);

it.each([{ shared: false, clear: false }, { shared: true, clear: false }, { shared: false, clear: true }])(
  'settles pending media publication before reconciling withdrawn references (%j)', async ({ shared, clear }) => {
  const hash = 'a'.repeat(64);
  const url = `cindy-media://blobs/${hash}.png`;
  h.sqlite!.prepare("INSERT INTO media_blobs VALUES (?, '.png', 'image/png', 8, 0, 1, 1)").run(hash);
  if (shared) {
    h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('keep-media', 'keep-media', 's1', 'user', ?, 1)").run(url);
  }
  const actual = await vi.importActual<typeof import('../../../cindy-media/chatAttachments')>('../../../cindy-media/chatAttachments');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(commitMessageMediaRefs).mockImplementationOnce(async (params, db) => {
    await pending;
    return actual.commitMessageMediaRefs(params, db);
  });
  let deleted!: () => void;
  const rollback = new Promise<void>((resolve) => { deleted = resolve; });
  const originalTx = h.client!.tx;
  h.client!.tx = async (name, args) => {
    const result = await originalTx(name, args);
    if ((args as { publication?: string }).publication === 'rollback') deleted();
    return result;
  };
  try {
    onAssistantTextEvent('s1', { text: url, agentMessageId: 'withdraw-media' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw-media', isFinal: true, isFullText: true }, null);
    await rollback;
    if (clear) {
      const boundary = Date.now() + 1000;
      h.sqlite!.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(boundary, 's1');
      noteSessionClearBoundary('s1', boundary);
    }
    release();
    await drainPersistQueue();
    await vi.mocked(commitMessageMediaRefs).mock.results[0].value;
    expect(h.sqlite!.prepare("SELECT count(*) AS n FROM media_refs WHERE ref_kind = 'session-attachment'").get())
      .toEqual({ n: shared ? 1 : 0 });
    expect(h.sqlite!.prepare('SELECT count(*) AS n FROM media_blobs').get()).toEqual({ n: 1 });
  } finally { release(); }
});


it.each([false, true])('reconciles replaced media without releasing another live message reference (shared=%s)', async (shared) => {
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  const oldUrl = `cindy-media://blobs/${oldHash}.png`;
  const newUrl = `cindy-media://blobs/${newHash}.png`;
  for (const hash of [oldHash, newHash]) {
    h.sqlite!.prepare("INSERT INTO media_blobs VALUES (?, '.png', 'image/png', 8, 0, 1, 1)").run(hash);
  }
  if (shared) {
    h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('keep-media', 'keep-media', 's1', 'user', ?, 1)").run(oldUrl);
  }
  onAssistantTextEvent('s1', { text: oldUrl, agentMessageId: 'replace-media' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  onAssistantTextEvent('s1', { text: newUrl, agentMessageId: 'replace-media', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect(h.sqlite!.prepare("SELECT hash FROM media_refs WHERE ref_kind = 'session-attachment' ORDER BY hash").all())
    .toEqual((shared ? [oldHash, newHash] : [newHash]).map((hash) => ({ hash })));
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM media_blobs').get()).toEqual({ n: 2 });
});
