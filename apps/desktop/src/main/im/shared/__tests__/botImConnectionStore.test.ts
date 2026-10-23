import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '', owner: 'owner-a' }));

vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', h.owner, ...parts),
}));
vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => false }));

import {
  addBotImConnectionRecord,
  archiveBotImTaskRow,
  listBotImConnections,
  listBotImConnectionsForBot,
  readBotImConnection,
  removeBotImConnectionRecord,
  secretKeyPrefixFor,
  setBotImConnectionGroupActivation,
  updateBotImConnectionRecord,
} from '../botImConnectionStore';

const file = () => path.join(h.root, 'owners', h.owner, 'bot-im-connections.json');

describe('bot im connection store', () => {
  beforeEach(() => {
    h.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-im-connections-'));
    h.owner = 'owner-a';
  });

  afterEach(() => {
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('starts empty and never exposes credentials in the record file', async () => {
    expect(listBotImConnections()).toEqual([]);
    const record = await addBotImConnectionRecord(
      { botId: 'bot-a', channel: 'telegram' },
      { now: () => 10, id: () => 'a1b2c3d4e5f6' },
    );
    expect(record).toEqual({
      id: 'a1b2c3d4e5f6',
      botId: 'bot-a',
      channel: 'telegram',
      createdAt: 10,
      botContextId: null,
    });
    const raw = fs.readFileSync(file(), 'utf8');
    expect(raw).not.toMatch(/token|secret/i);
    expect(secretKeyPrefixFor(record.id)).toBe('bot-im-a1b2c3d4e5f6-');
    expect(secretKeyPrefixFor(record.id)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps the Feishu service, records the platform id once connected, and lists per bot', async () => {
    await addBotImConnectionRecord(
      { botId: 'bot-a', channel: 'feishu', service: 'lark' },
      { now: () => 1, id: () => 'aaaaaaaaaaaa' },
    );
    await addBotImConnectionRecord(
      { botId: 'bot-b', channel: 'telegram' },
      { now: () => 2, id: () => 'bbbbbbbbbbbb' },
    );
    expect(readBotImConnection('aaaaaaaaaaaa')?.service).toBe('lark');
    const updated = await updateBotImConnectionRecord('aaaaaaaaaaaa', { botContextId: 'cli_x' });
    expect(updated?.botContextId).toBe('cli_x');
    expect(listBotImConnectionsForBot('bot-a').map((r) => r.id)).toEqual(['aaaaaaaaaaaa']);
    expect(listBotImConnections().map((r) => r.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });

  it('removes a record and ignores ids that do not match the id shape', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => 'cccccccccccc' });
    expect(await removeBotImConnectionRecord('not-an-id')).toBeNull();
    expect(await removeBotImConnectionRecord('cccccccccccc')).toMatchObject({ id: 'cccccccccccc' });
    expect(listBotImConnections()).toEqual([]);
    expect(readBotImConnection('cccccccccccc')).toBeNull();
  });

  it('drops malformed entries written by hand', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        connections: {
          dddddddddddd: { botId: 'bot-a', channel: 'telegram', createdAt: 5, botContextId: null },
          'bad id': { botId: 'bot-a', channel: 'telegram' },
          eeeeeeeeeeee: { botId: 'bot-a', channel: 'slack' },
        },
      }),
    );
    expect(listBotImConnections().map((r) => r.id)).toEqual(['dddddddddddd']);
  });

  it('keeps per-group activation on the record and drops anything but chatId → always', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => '111111111111' });
    expect((await setBotImConnectionGroupActivation('111111111111', '-1001', 'always'))?.groupActivation).toEqual({
      '-1001': 'always',
    });
    await setBotImConnectionGroupActivation('111111111111', '-1002', 'always');
    expect(readBotImConnection('111111111111')?.groupActivation).toEqual({ '-1001': 'always', '-1002': 'always' });
    // mention 是缺省: 清掉这一项, 全空时整个字段不落盘。
    await setBotImConnectionGroupActivation('111111111111', '-1001', 'mention');
    expect(readBotImConnection('111111111111')?.groupActivation).toEqual({ '-1002': 'always' });
    await setBotImConnectionGroupActivation('111111111111', '-1002', 'mention');
    expect(readBotImConnection('111111111111')?.groupActivation).toBeUndefined();
    expect(await setBotImConnectionGroupActivation('nope', '-1', 'always')).toBeNull();

    fs.writeFileSync(
      file(),
      JSON.stringify({
        connections: {
          '222222222222': {
            botId: 'bot-a',
            channel: 'telegram',
            createdAt: 5,
            botContextId: '9',
            groupActivation: { '-1': 'always', '-2': 'mention', abc: 'always', '-3': 'nope' },
          },
        },
      }),
    );
    expect(readBotImConnection('222222222222')?.groupActivation).toEqual({ '-1': 'always' });
  });

  // 用户明确要求只归档列表、不归档 session。既有存储测试没有行级显示偏好。
  // 最小输入一条连接、两个任务行；unit 走真实文件入口验证并发合并、持久化与账号隔离。
  it('persists row archives atomically per connection without changing its binding', async () => {
    const record = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    await Promise.all([archiveBotImTaskRow(record, 'session-main'), archiveBotImTaskRow(record, 'session-topic')]);
    expect(readBotImConnection(record.id)).toMatchObject({
      botId: 'bot-a', channel: 'feishu', botContextId: null,
      archivedTaskRows: { 'session-main': expect.any(Number), 'session-topic': expect.any(Number) },
    });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).connections[record.id].archivedTaskRows)
      .toEqual(readBotImConnection(record.id)?.archivedTaskRows);
    h.owner = 'owner-b';
    expect(readBotImConnection(record.id)).toBeNull();
  });

  it('is scoped per data owner', async () => {
    await addBotImConnectionRecord({ botId: 'bot-a', channel: 'telegram' }, { id: () => 'ffffffffffff' });
    h.owner = 'owner-b';
    expect(listBotImConnections()).toEqual([]);
  });

  // PR #6899 review: accumulated archive markers must not consume the shared
  // connection settings budget. Exercise the real file writer, not a mock.
  it.each(['count', 'bytes'] as const)('reserves connection settings space when archive %s capacity is reached', async (limit) => {
    const first = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    const second = await addBotImConnectionRecord({ botId: 'bot-b', channel: 'telegram' }, { id: () => 'bbbbbbbbbbbb' });
    const document = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const count = limit === 'count' ? 512 : 330;
    for (const [index, id] of [first.id, second.id].entries()) {
      document.connections[id].archivedTaskRows = Object.fromEntries(Array.from({ length: count / 2 }, (_, i) => [
        `s-${index}-${i}${limit === 'bytes' ? '-'.repeat(185) : ''}`, 1,
      ]));
    }
    fs.writeFileSync(file(), JSON.stringify(document, null, 2));
    const before = fs.readFileSync(file(), 'utf8');
    await expect(archiveBotImTaskRow(first, 'new-session')).rejects.toThrow(/ARCHIVE_CAPACITY_REACHED/);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    await addBotImConnectionRecord({ botId: 'bot-c', channel: 'telegram' }, { id: () => 'cccccccccccc' });
    await setBotImConnectionGroupActivation(second.id, '-1001', 'always');
    expect(readBotImConnection(second.id)?.groupActivation).toEqual({ '-1001': 'always' });
    expect(listBotImConnections()).toHaveLength(3);
    const obsolete = Object.fromEntries(Object.keys(document.connections[first.id].archivedTaskRows)
      .slice(0, limit === 'count' ? 1 : count / 2).map((id) => [id, 1]));
    await archiveBotImTaskRow(second, 'new-session', [{ connection: first, cutoffs: obsolete }]);
    const archives = readBotImConnection(first.id)?.archivedTaskRows;
    for (const id of Object.keys(obsolete)) expect(archives?.[id]).toBeUndefined();
    expect(readBotImConnection(second.id)?.archivedTaskRows).toEqual({
      ...document.connections[second.id].archivedTaskRows, 'new-session': expect.any(Number),
    });
  });

  it('serializes concurrent archives at the owner-wide limit', async () => {
    const record = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    const document = JSON.parse(fs.readFileSync(file(), 'utf8'));
    document.connections[record.id].archivedTaskRows = Object.fromEntries(Array.from({ length: 511 }, (_, i) => [`existing-${i}`, 1]));
    fs.writeFileSync(file(), JSON.stringify(document));
    const results = await Promise.allSettled([archiveBotImTaskRow(record, 'new-a'), archiveBotImTaskRow(record, 'new-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(Object.keys(readBotImConnection(record.id)?.archivedTaskRows ?? {})).toHaveLength(512);
  });

  it('reclaims only observed obsolete cutoffs and preserves a concurrent rearchive', async () => {
    const record = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    const document = JSON.parse(fs.readFileSync(file(), 'utf8'));
    document.connections[record.id].archivedTaskRows = { obsolete: 1, rearchived: 2, dormant: 1 };
    fs.writeFileSync(file(), JSON.stringify(document));
    // The runtime observed cutoff=1 before another writer rearchived this row.
    await archiveBotImTaskRow(record, 'new-session', [{ connection: record, cutoffs: { obsolete: 1, rearchived: 1 } }]);
    expect(readBotImConnection(record.id)?.archivedTaskRows).toEqual({
      rearchived: 2, dormant: 1, 'new-session': expect.any(Number),
    });
  });

  it('preserves another connection whose binding changed during reclamation lookup', async () => {
    const first = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    const second = await addBotImConnectionRecord({ botId: 'bot-b', channel: 'telegram' }, { id: () => 'bbbbbbbbbbbb' });
    await archiveBotImTaskRow(first, 'old-session');
    const observed = readBotImConnection(first.id)!;
    await updateBotImConnectionRecord(first.id, { botContextId: 'new-binding' });
    await archiveBotImTaskRow(second, 'new-session', [{ connection: observed, cutoffs: observed.archivedTaskRows! }]);
    expect(readBotImConnection(first.id)?.archivedTaskRows).toEqual(observed.archivedTaskRows);
    expect(readBotImConnection(second.id)?.archivedTaskRows?.['new-session']).toEqual(expect.any(Number));
  });

  it('keeps valid prototype-named task ids as ordinary archive entries', async () => {
    const record = await addBotImConnectionRecord({ botId: 'bot-a', channel: 'feishu' }, { id: () => 'aaaaaaaaaaaa' });
    await archiveBotImTaskRow(record, '__proto__');
    await archiveBotImTaskRow(record, 'constructor');
    const archived = readBotImConnection(record.id)?.archivedTaskRows;
    expect(Object.hasOwn(archived ?? {}, '__proto__')).toBe(true);
    expect(archived?.['__proto__']).toEqual(expect.any(Number));
    expect(archived?.constructor).toEqual(expect.any(Number));
  });
});
