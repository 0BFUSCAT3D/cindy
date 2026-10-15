import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).get(...args) as T | undefined,
    query: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).all(...args) as T[],
  }),
}));

import { listBotRecallSessionIds, resolveBotHistorySessionIds } from '../botHistoryScope.js';

beforeEach(() => {
  h.sqlite = new Database(':memory:');
  h.sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, created_at INTEGER);
    CREATE TABLE bot_delegations (requesting_bot_id TEXT, child_session_id TEXT, created_at INTEGER);
    INSERT INTO sessions VALUES ('bot-main', 'bot'), ('owner-task', 'desktop'), ('child-1', 'desktop');
    INSERT INTO bot_session_links VALUES ('bot-main', 'bot-1', 1), ('other-bot-main', 'bot-2', 2);
    INSERT INTO bot_delegations VALUES ('bot-1', 'child-1', 3), ('bot-1', NULL, 4), ('bot-2', 'child-2', 5);
  `);
});
afterEach(() => h.sqlite?.close());

describe('resolveBotHistorySessionIds', () => {
  it('scopes a Bot to its own sessions plus the background tasks it started', async () => {
    expect(await resolveBotHistorySessionIds('bot-main', undefined)).toEqual(['child-1', 'bot-main']);
  });

  it('leaves ordinary tasks unscoped and fails closed for unknown callers', async () => {
    expect(await resolveBotHistorySessionIds('owner-task', undefined)).toBeNull();
    expect(await resolveBotHistorySessionIds('missing', undefined)).toEqual([]);
  });
});

describe('listBotRecallSessionIds', () => {
  it('keeps every chat session ahead of background tasks within the bound, newest first', async () => {
    // 恢复前的旧对话(更早)+ 当前对话,再加一堆比它们都新的后台任务。
    h.sqlite!.exec(`
      INSERT INTO bot_session_links VALUES ('bot-main-old', 'bot-1', 0);
      ${Array.from({ length: 6 }, (_, i) => `INSERT INTO bot_delegations VALUES ('bot-1', 'task-${i}', ${10 + i});`).join('\n')}
    `);
    const ids = await listBotRecallSessionIds('bot-main', 4);
    expect(ids).toEqual(['bot-main', 'bot-main-old', 'task-5', 'task-4']);
    // 名额够时全部带上;非伙伴 / 未知调用方 / 零名额都为空。
    expect(await listBotRecallSessionIds('bot-main', 50)).toEqual([
      'bot-main', 'bot-main-old', 'task-5', 'task-4', 'task-3', 'task-2', 'task-1', 'task-0', 'child-1',
    ]);
    expect(await listBotRecallSessionIds('owner-task', 4)).toEqual([]);
    expect(await listBotRecallSessionIds('missing', 4)).toEqual([]);
    expect(await listBotRecallSessionIds('bot-main', 0)).toEqual([]);
  });
});
