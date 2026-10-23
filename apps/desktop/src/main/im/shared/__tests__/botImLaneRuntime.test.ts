/**
 * 「消息平台」页的隐藏任务小节(botImLaneRuntime):
 *   - 列表只含这条连接的落点(伙伴主任务 + 本连接 route key 前缀下的专线), 同一伙伴的
 *     其它连接、同渠道另一个机器人的专线都不混进来;
 *   - 「重新开始」只接受这条连接自己的任务, 渲染端传来的其它任务 id 不会被重启。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DbClient } from '../../../localDb/client/DbClient';
import { getDbClient } from '../../../localDb/client/current';
import type { BotImConnectionRecord } from '../../../../shared/botImConnection';
import type { BotImTaskArchiveCleanup } from '../botImConnectionStore';

const h = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  archived: new Set<string>(),
  owner: 'owner-a',
  reclaimable: [] as (readonly BotImTaskArchiveCleanup[])[],
  sql: [] as string[],
  sqlAtArchive: [] as string[],
}));

vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => false }));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../localDb/client/current', () => ({ getDbClient: vi.fn() }));
vi.mock('../botImConnectionStore', () => ({
  readBotImConnection: (id: string) => h.records.get(id) ?? null,
  listBotImConnections: () => [...h.records.values()] as BotImConnectionRecord[],
  archiveBotImTaskRow: async (record: BotImConnectionRecord, sessionId: string, reclaimable: readonly BotImTaskArchiveCleanup[] = []) => {
    h.sqlAtArchive.push(...h.sql);
    h.reclaimable.push(reclaimable);
    const next = { ...record, archivedTaskRows: { ...record.archivedTaskRows, [sessionId]: Date.now() } };
    h.records.set(record.id, next);
    h.archived.add(sessionId);
    return next;
  },
}));

import {
  __testing,
  archiveBotImConnectionLane,
  configureBotImLaneRuntime,
  listBotImConnectionLanes,
  resetBotImConnectionLane,
  type BotImLaneActivity,
  type BotImLaneLink,
} from '../botImLaneRuntime';

const TELEGRAM: BotImConnectionRecord = {
  id: 'conn-tg',
  botId: 'bot-a',
  channel: 'telegram',
  botContextId: '777',
  createdAt: 1,
};

const LINKS: BotImLaneLink[] = [
  { sessionId: 's-main', role: 'canonical', routeKey: null },
  { sessionId: 's-group', role: 'channel', routeKey: 'im:telegram:777:g:-1001' },
  { sessionId: 's-topic', role: 'channel', routeKey: 'im:telegram:777:g:-1001:t:42' },
  { sessionId: 's-guest', role: 'channel', routeKey: 'im:telegram:777:dm:555' },
  // 同一伙伴的飞书连接 / 同渠道另一个机器人: 不属于这条连接。
  { sessionId: 's-feishu', role: 'channel', routeKey: 'im:feishu:cli_x:g:oc_1' },
  { sessionId: 's-other-bot', role: 'channel', routeKey: 'im:telegram:7770:g:-1001' },
];

function activity(over: Partial<BotImLaneActivity> = {}): BotImLaneActivity {
  return {
    lastActivityAt: 1_000,
    lastTurnFailed: false,
    contextMessageCount: 0,
    origin: { chatName: null, senderName: null },
    ...over,
  };
}

const ACTIVITY: Record<string, BotImLaneActivity> = {
  's-main': activity({ lastActivityAt: 100, contextMessageCount: 3 }),
  's-group': activity({ lastActivityAt: 5_000, origin: { chatName: 'Stale name', senderName: 'Ann' } }),
  's-topic': activity({ lastActivityAt: 9_000, lastTurnFailed: true, origin: { chatName: 'Release room', senderName: 'Bo' } }),
  's-guest': activity({ lastActivityAt: 2_000, contextMessageCount: 7, origin: { chatName: null, senderName: 'Cleo' } }),
};

const listLinks = vi.fn(async (botId: string) => (botId === TELEGRAM.botId ? LINKS : []));
const readActivity = vi.fn(async (sessionId: string) => ACTIVITY[sessionId] ?? activity());
const readLastActivityAt = vi.fn(async (sessionId: string) => (ACTIVITY[sessionId] ?? activity()).lastActivityAt);
const restartSession = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const knownGroups = vi.fn(async () => [{ chatId: '-1001', chatName: 'Launch crew' }]);

beforeEach(() => {
  vi.clearAllMocks();
  h.records.clear();
  h.archived.clear();
  h.reclaimable.length = 0;
  h.sql.length = 0;
  h.sqlAtArchive.length = 0;
  h.owner = 'owner-a';
  h.records.set(TELEGRAM.id, TELEGRAM);
  __testing.setStore({ listLinks, readActivity, readLastActivityAt });
  configureBotImLaneRuntime({ isTurnRunning: (id) => id === 's-guest', restartSession });
});

describe('botImLaneRuntime', () => {
  // Only route/activity evidence may release archive capacity; dormant records
  // must stay hidden and a later concurrent archive is checked by the store.
  it('identifies only unlinked or superseded cutoffs for reclamation', async () => {
    h.records.set(TELEGRAM.id, { ...TELEGRAM, archivedTaskRows: { 's-main': 200, 's-topic': 1, removed: 1 } });
    await archiveBotImConnectionLane(TELEGRAM.id, 's-group');
    expect(h.reclaimable).toEqual([[{ connection: expect.objectContaining({ id: TELEGRAM.id }), cutoffs: { 's-topic': 1, removed: 1 } }]]);
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not reclaim a cutoff when activity lookup fails', async () => {
    h.records.set(TELEGRAM.id, { ...TELEGRAM, archivedTaskRows: { 's-topic': 1 } });
    readLastActivityAt.mockRejectedValueOnce(new Error('activity unavailable'));
    await archiveBotImConnectionLane(TELEGRAM.id, 's-group');
    expect(h.reclaimable).toEqual([[]]);
  });

  it.each(['empty', 'active', 'unavailable'] as const)('checks another connection with %s routes before applying the shared archive budget', async (routes) => {
    const cutoffs = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`obsolete-${i}`, 1]));
    const legacy = { ...TELEGRAM, id: 'old-connection', botId: 'old-bot', archivedTaskRows: cutoffs };
    h.records.set(legacy.id, legacy);
    if (routes === 'unavailable') listLinks.mockResolvedValueOnce(LINKS).mockRejectedValueOnce(new Error('routes unavailable'));
    if (routes === 'active') listLinks.mockResolvedValueOnce(LINKS).mockResolvedValueOnce(
      Object.keys(cutoffs).map((sessionId, i) => ({ sessionId, role: 'channel', routeKey: `im:telegram:777:g:-${1000 + i}` })),
    );
    await archiveBotImConnectionLane(TELEGRAM.id, 's-group');
    expect(h.reclaimable).toEqual([routes === 'unavailable' ? [] : [{ connection: legacy, cutoffs }]]);
    expect(readLastActivityAt).toHaveBeenCalledTimes(routes === 'active' ? 512 : 0);
    expect(readActivity.mock.calls.every(([sessionId]) => !sessionId.startsWith('obsolete-'))).toBe(true);
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('rejects an account change during reclamation lookup before any archive write', async () => {
    h.records.set(TELEGRAM.id, { ...TELEGRAM, archivedTaskRows: { 's-topic': 1, 's-main': 1 } });
    readLastActivityAt.mockImplementationOnce(async () => { h.owner = 'owner-b'; return ACTIVITY['s-topic'].lastActivityAt; });
    await expect(archiveBotImConnectionLane(TELEGRAM.id, 's-group')).rejects.toThrow(/OWNER_CHANGED/);
    expect(h.archived.size).toBe(0);
    expect(readLastActivityAt).toHaveBeenCalledTimes(1);
    expect(readActivity).not.toHaveBeenCalled();
  });

  // The real archive entry must not read list details for every old cutoff.
  // In-memory SQLite keeps the query budget and visibility boundary observable.
  it('reclaims 512 linked markers with one activity query each and preserves cutoff visibility', async () => {
    const sqlite = new Database(':memory:', { verbose: (statement) => h.sql.push(String(statement)) });
    try {
      sqlite.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, status TEXT, cleared_at INTEGER);
        CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, role TEXT, route_key TEXT, archived_at INTEGER);
        CREATE TABLE messages (session_id TEXT, role TEXT, created_at INTEGER, rewind_at INTEGER, agent_meta TEXT);
      `);
      const addSession = sqlite.prepare("INSERT INTO sessions VALUES (?, 'bot', 'active', NULL)");
      const addLink = sqlite.prepare("INSERT INTO bot_session_links VALUES (?, ?, 'channel', ?, NULL)");
      const addMessage = sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, NULL)');
      addSession.run('s-group');
      addLink.run('s-group', TELEGRAM.botId, 'im:telegram:777:g:-1001');
      // Same-millisecond ordering must still determine the refreshed list state.
      addMessage.run('s-group', 'assistant', 5, null);
      addMessage.run('s-group', 'error', 5, null);
      const cutoffs: Record<string, number> = {};
      const expected: Record<string, number> = {};
      for (let i = 0; i < 512; i += 1) {
        const sessionId = `old-${i}`;
        cutoffs[sessionId] = 10;
        addSession.run(sessionId);
        addLink.run(sessionId, 'old-bot', `im:telegram:777:g:old-${i}`);
        const kind = i % 5;
        if (kind < 3) {
          addMessage.run(sessionId, ['user', 'assistant', 'error'][kind], 20, null);
          expected[sessionId] = 10;
        } else if (kind === 3) {
          addMessage.run(sessionId, 'user', 10, null);
        }
        // None of these newer rows is visible activity that may release capacity.
        addMessage.run(sessionId, 'assistant', 30, 30);
        addMessage.run(sessionId, 'tool', 40, null);
        addMessage.run(sessionId, 'context_rebuild', 50, 50);
      }
      const legacy = { ...TELEGRAM, id: 'old-connection', botId: 'old-bot', archivedTaskRows: cutoffs };
      h.records.set(legacy.id, legacy);
      vi.mocked(getDbClient).mockReturnValue({ drizzle: drizzle(sqlite) } as unknown as DbClient);
      __testing.setStore(null);
      h.sql.length = 0;

      await archiveBotImConnectionLane(TELEGRAM.id, 's-group');
      expect(h.reclaimable).toEqual([[{ connection: legacy, cutoffs: expected }]]);
      const queries = h.sqlAtArchive.filter((statement) => /^select\b/i.test(statement));
      // Two scoped-link lookups plus at most one activity SELECT per old marker.
      expect(queries.length).toBeLessThanOrEqual(514);
      expect(queries.some((statement) => /count\(|agent_meta|cleared_at|context_rebuild/i.test(statement))).toBe(false);
      h.records.set(TELEGRAM.id, TELEGRAM);
      expect((await listBotImConnectionLanes(TELEGRAM.id)).lanes).toMatchObject([
        { sessionId: 's-group', state: 'failed', lastActivityAt: 5 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  // 用户确认的专线归档：既有覆盖只有重启；unit 注入存储验证列表移除与越权拒绝。
  it('archives only the selected connection row and preserves all session links', async () => {
    const payload = await archiveBotImConnectionLane(TELEGRAM.id, 's-topic');
    expect(payload.lanes.map((lane) => lane.sessionId)).toEqual(['s-main', 's-group', 's-guest']);
    expect(h.archived).toEqual(new Set(['s-topic']));
    await expect(archiveBotImConnectionLane(TELEGRAM.id, 's-feishu')).rejects.toThrow(/LANE_NOT_FOUND/);
    await expect(archiveBotImConnectionLane(TELEGRAM.id, 's-other-bot')).rejects.toThrow(/LANE_NOT_FOUND/);
    expect(h.archived).toEqual(new Set(['s-topic']));
    expect(await listLinks(TELEGRAM.botId)).toEqual(LINKS);
    const afterOwnerArchive = await archiveBotImConnectionLane(TELEGRAM.id, 's-main');
    expect(afterOwnerArchive.lanes.map((lane) => lane.sessionId)).toEqual(['s-group', 's-guest']);
    expect(restartSession).not.toHaveBeenCalled();
  });

  // 列表归档不改变 session：后续消息仍在原任务上，既有用例不覆盖归档后的活动。
  it('shows the same session again after new activity without creating or restarting it', async () => {
    await archiveBotImConnectionLane(TELEGRAM.id, 's-topic');
    readActivity.mockImplementationOnce(async () => ACTIVITY['s-main']);
    readActivity.mockImplementationOnce(async () => ACTIVITY['s-group']);
    readActivity.mockImplementationOnce(async () => activity({ lastActivityAt: Date.now() + 1 }));
    const payload = await listBotImConnectionLanes(TELEGRAM.id);
    expect(payload.lanes.some((lane) => lane.sessionId === 's-topic')).toBe(true);
    expect(await listLinks(TELEGRAM.botId)).toEqual(LINKS);
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('does not archive after an account change during the ownership lookup', async () => {
    listLinks.mockImplementationOnce(async () => { h.owner = 'owner-b'; return LINKS; });
    await expect(archiveBotImConnectionLane(TELEGRAM.id, 's-topic')).rejects.toThrow(/OWNER_CHANGED/);
    expect(h.archived.size).toBe(0);
  });

  it('lists only the lanes of this connection, with names, state and order from existing data', async () => {
    const payload = await listBotImConnectionLanes(TELEGRAM.id, { knownGroups });

    expect(listLinks).toHaveBeenCalledWith('bot-a');
    expect(readActivity).not.toHaveBeenCalledWith('s-feishu');
    expect(readActivity).not.toHaveBeenCalledWith('s-other-bot');
    expect(payload.lanes.map((lane) => [lane.sessionId, lane.kind, lane.name, lane.state])).toEqual([
      ['s-main', 'owner-dm', null, 'idle'],
      ['s-topic', 'topic', 'Launch crew', 'failed'],
      ['s-group', 'group', 'Launch crew', 'idle'],
      ['s-guest', 'guest-dm', 'Cleo', 'running'],
    ]);
    expect(payload.lanes.find((lane) => lane.sessionId === 's-topic')).toMatchObject({ chatId: '-1001', threadId: '42' });
    expect(payload.lanes.find((lane) => lane.sessionId === 's-guest')).toMatchObject({ chatId: '555', contextMessageCount: 7 });
  });

  it('a connection that never came online has no lanes yet', async () => {
    h.records.set(TELEGRAM.id, { ...TELEGRAM, botContextId: null });
    await expect(listBotImConnectionLanes(TELEGRAM.id)).resolves.toEqual({ connectionId: TELEGRAM.id, lanes: [] });
    expect(listLinks).not.toHaveBeenCalled();
  });

  it('restarts only a task that belongs to this connection', async () => {
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-feishu')).rejects.toThrow(/LANE_NOT_FOUND/);
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-other-bot')).rejects.toThrow(/LANE_NOT_FOUND/);
    await expect(resetBotImConnectionLane('conn-missing', 's-group')).rejects.toThrow(/CONNECTION_NOT_FOUND/);
    expect(restartSession).not.toHaveBeenCalled();

    const payload = await resetBotImConnectionLane(TELEGRAM.id, 's-group');
    expect(restartSession).toHaveBeenCalledExactlyOnceWith('s-group');
    expect(payload.lanes).toHaveLength(4);
  });

  it('reports a failed restart instead of a refreshed list', async () => {
    restartSession.mockRejectedValueOnce(new Error('Bot restart timed out'));
    await expect(resetBotImConnectionLane(TELEGRAM.id, 's-main')).rejects.toThrow(/LANE_RESET_FAILED/);
    expect(restartSession).toHaveBeenCalledWith('s-main');
  });
});
