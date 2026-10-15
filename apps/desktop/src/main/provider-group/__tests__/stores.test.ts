/**
 * 组设置与任务绑定的本机存储：坏形态清洗与容量淘汰；读写链路走真文件(临时目录)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ boundaryPending: false }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-store-test-'));

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => path.join(tmpDir, name),
  activeOwnerScopeKey: () => 'owner-test',
  isAppSessionBoundaryPending: () => scope.boundaryPending,
}));

const store = await import('../store.js');
const bindings = await import('../bindings.js');
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
afterEach(() => { scope.boundaryPending = false; });

describe('provider group store', () => {
  it.each(['save', 'delete'])('does not %s when teardown starts before the file lock is acquired', async (action) => {
    const initial = (await store.writeProviderGroup('boundary', { members: [{ kind: 'local' }] }))!;
    const pending = store.writeProviderGroup('boundary', action === 'delete' ? null : { ...initial, autoSwitch: false }, initial);
    // updateAtomic 已开始等待写锁，但 owner key 尚未推进。
    scope.boundaryPending = true;
    await expect(pending).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(store.readProviderGroup('boundary')).toEqual(initial);
  });

  it('drops invalid groups and empty groups when reading', () => {
    expect(store.__testing.normalize({
      groups: {
        anthropic: { strategy: 'least', members: [{ kind: 'local' }] },
        'bad id': { members: [{ kind: 'local' }] },
        empty: { members: [] },
      },
    })).toEqual({
      groups: {
        anthropic: {
          strategy: 'least',
          autoSwitch: true,
          members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
        },
      },
    });
  });

  it('writes, reads back and deletes a group', async () => {
    const written = await store.writeProviderGroup('anthropic', {
      strategy: 'order',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' }],
    });
    expect(written?.members).toHaveLength(2);
    expect(store.readProviderGroup('anthropic')?.strategy).toBe('order');
    await store.writeProviderGroup('anthropic', null);
    expect(store.readProviderGroup('anthropic')).toBeNull();
  });

  it('preserves another editor’s members and limits instead of overwriting them with an old snapshot', async () => {
    const initial = (await store.writeProviderGroup('stale', { members: [{ kind: 'local' }] }))!;
    const updated = (await store.writeProviderGroup('stale', {
      ...initial,
      members: [{ ...initial.members[0], limit: 8 }, { kind: 'device', agentDeviceId: 'mini', providerId: 'stale' }],
    }, initial))!;
    await expect(store.writeProviderGroup('stale', { ...initial, autoSwitch: false }, initial))
      .rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    await expect(store.writeProviderGroup('stale', null, initial)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('stale')).toEqual(updated);
    // 重新读取后由用户再次修改，保留另一台已添加的电脑和上限。
    const saved = await store.writeProviderGroup('stale', { ...updated, autoSwitch: false }, updated);
    expect(saved).toEqual({ ...updated, autoSwitch: false });
  });

  it('compares under the file lock so only one of two concurrent edits can use the same snapshot', async () => {
    const initial = (await store.writeProviderGroup('concurrent', { members: [{ kind: 'local' }] }))!;
    const edits = [{ ...initial, autoSwitch: false }, { ...initial, strategy: 'round' as const }];
    const results = await Promise.allSettled(edits.map((config) => store.writeProviderGroup('concurrent', config, initial)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'PROVIDER_GROUP_CHANGED' }) }),
    ]);
    expect(store.readProviderGroup('concurrent')).toEqual(edits[results.findIndex((result) => result.status === 'fulfilled')]);
  });

  it('protects concurrent creation and does not recreate a group deleted after it was read', async () => {
    const config = { members: [{ kind: 'local' }] };
    const created = await store.writeProviderGroup('creation', config, null);
    await expect(store.writeProviderGroup('creation', { ...config, autoSwitch: false }, null))
      .rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('creation')).toEqual(created);
    await store.writeProviderGroup('creation', null, created);
    await expect(store.writeProviderGroup('creation', created, created)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('creation')).toBeNull();
  });
});

describe('provider group bindings', () => {
  it('keeps bindings and release records unchanged when teardown starts during the write-lock wait', async () => {
    await bindings.writeProviderGroupBinding('boundary-task', { providerId: 'boundary', memberKey: 'local' }, 1);
    const pending = bindings.pruneProviderGroupBindings('boundary', null);
    scope.boundaryPending = true;
    await expect(pending).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(bindings.readProviderGroupBinding('boundary-task')).toMatchObject({ providerId: 'boundary', memberKey: 'local' });
    expect(bindings.isProviderGroupReleased('boundary-task', { providerId: 'boundary' })).toBe(false);
  });

  it('keeps only well-formed bindings', () => {
    expect(bindings.__testing.normalize({
      sessions: {
        s1: { providerId: 'anthropic', memberKey: 'local', at: 5 },
        's 2': { providerId: 'anthropic', memberKey: 'local', at: 5 },
        s3: { providerId: 'bad id', memberKey: 'local' },
      },
    })).toEqual({ sessions: { s1: { providerId: 'anthropic', memberKey: 'local', at: 5 } } });
  });

  it('evicts the oldest bindings beyond capacity', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: bindings.MAX_PROVIDER_GROUP_BINDINGS + 3 }, (_, i) => [`s${i}`, { providerId: 'p', memberKey: 'local', at: i }]),
    );
    const pruned = bindings.__testing.prune(sessions);
    expect(Object.keys(pruned)).toHaveLength(bindings.MAX_PROVIDER_GROUP_BINDINGS);
    expect(pruned.s0).toBeUndefined();
    expect(pruned[`s${bindings.MAX_PROVIDER_GROUP_BINDINGS + 2}`]).toBeDefined();
  });

  it('writes and clears a binding', async () => {
    await bindings.writeProviderGroupBinding('s1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 42);
    expect(bindings.readProviderGroupBinding('s1')).toEqual({ providerId: 'anthropic', memberKey: 'device:mini:x', at: 42 });
    await bindings.writeProviderGroupBinding('s1', null);
    expect(bindings.readProviderGroupBinding('s1')).toBeNull();
  });

  it('releases bindings of removed computers and of deleted groups only', async () => {
    await bindings.writeProviderGroupBinding('a', { providerId: 'anthropic', memberKey: 'local' }, 1);
    await bindings.writeProviderGroupBinding('b', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 2);
    await bindings.writeProviderGroupBinding('c', { providerId: 'openai', memberKey: 'device:mini:y' }, 3);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']));
    expect(bindings.readProviderGroupBinding('a')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('b')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('a')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
  });

  it('remembers, per group, the tasks released by removing a computer or deleting the group', async () => {
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 1);
    await bindings.writeProviderGroupBinding('x2', { providerId: 'anthropic', memberKey: 'local' }, 2);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']), 10);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'openai' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x2', { providerId: 'anthropic' })).toBe(false);

    await bindings.markProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' }, 11);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: null })).toBe(false);
    // 单独一个文件：旧版本只读绑定文件，读不到也改写不到它。
    expect(fs.existsSync(path.join(tmpDir, 'provider-group-released.json'))).toBe(true);

    // 由同一个组重新分配(例如清空后当作新任务)时作废；别的组的分配不影响。
    await bindings.writeProviderGroupBinding('x1', { providerId: 'openai', memberKey: 'local' }, 12);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'local' }, 13);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(false);
  });

  it('keeps only well-formed release records', () => {
    expect(bindings.__testing.normalizeReleased({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
        c: { providerId: 'bad id', at: 3 },
        d: { providerId: 'anthropic', groupDeviceId: 'bad id', at: 4 },
        'e e': { providerId: 'anthropic', at: 5 },
      },
    })).toEqual({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
      },
    });
  });

  it('keeps bindings to a group on another computer in their own file, one group per task', async () => {
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini' }, 7);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 7 });
    // 本机的组只数本机那份：另一台电脑的组不进本机分配器的统计，也不被本机删组时清掉。
    expect(bindings.listProviderGroupBindings().r1).toBeUndefined();
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeDefined();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('r1')).not.toBeNull();
    // 降级后的旧版本只读本机那份，读不到它。
    const localFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(localFile.sessions?.r1).toBeUndefined();
    // 改归本机的组时另一份里的同一任务一并清掉。
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local' }, 8);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', at: 8 });
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeUndefined();
    await bindings.writeProviderGroupBinding('r1', null);
    expect(bindings.readProviderGroupBinding('r1')).toBeNull();
  });

  it('drops remote bindings without a valid group computer', () => {
    expect(bindings.__testing.normalizeRemote({
      sessions: {
        r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 },
        r2: { providerId: 'anthropic', memberKey: 'local' },
        r3: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'bad id' },
      },
    })).toEqual({ sessions: { r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 } } });
  });
});
