import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES, type ProviderShareOwned } from '@cindy/device-link';
import type { ProviderUsageHistoryView } from '../../../shared/providerShare';
import { parseProviderShareInsights } from '../../../shared/providerShareInsights';
import { createProviderShareInsightsReader } from '../providerShareInsights';

/* 测试价值：通过新只读 reader 验证四种能力组合、匿名投影、独立失败和撤权时序。
 * 依据：provider-sharing 的最小范围及账号隔离；旧 dispatch/management 测试没有新 reader。
 * 最小失败输入：一项查询失败、在途关闭后重开、同 providerId 换账号、转来的一行用量。
 * 缓存回归：PR #6482 P1；旧覆盖仅单供应商，补 A→B→A、过期和旧失败晚于新读取的时序。
 * 回包预算：#4316096976，旧覆盖未包含昵称/头像膨胀；用大名单加已有预算内账本触发最终帧超限。
 * tier: unit；依赖注入，无 Electron/外网/真实等待。单文件耗时见执行报告。 */
const day = {
  day: '2026-10-19',
  kind: 'codex',
  model: 'model',
  providerId: 'private-provider',
  memberKey: 'private-device',
  turns: 1,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount: 1, currency: 'USD' as const },
};
function fixture() {
  const state = {
    owner: 'a',
    revision: 0,
    visibility: { quota: true, usage: true, revision: 0 },
    active: true,
  };
  const access = { shareId: 'share', memberId: 'member', providerId: 'provider' };
  const share: ProviderShareOwned = {
    shareId: 'share',
    providerId: 'provider',
    hostDeviceId: 'private-host',
    providerLabel: 'Provider',
    createdAt: '',
    requests: [],
    members: [
      {
        memberId: 'member',
        displayName: 'Alice',
        avatarUrl: null,
        region: 'global',
        status: 'active',
        joinedAt: '',
      },
    ],
  };
  const history: ProviderUsageHistoryView = {
    providerId: 'provider',
    todayKey: '2026-10-19',
    coverageStart: null,
    self: { lastUsedAt: 1, days: [day] },
    members: [
      { shareId: 'share', memberId: 'member', lastUsedAt: 2, days: [day] },
      { shareId: 'share', memberId: 'deleted', lastUsedAt: 3, days: [day] },
    ],
    relays: [
      { deviceId: 'private-device', deviceName: 'Secret Computer', lastUsedAt: 3, days: [day] },
      { deviceId: 'other-device', deviceName: 'Other Computer', lastUsedAt: 4, days: [day] },
    ],
  };
  const deps = {
    captureScope: () => {
      const owner = state.owner;
      return () => {
        if (owner !== state.owner) throw new Error('account changed');
      };
    },
    scopeKey: () => state.owner,
    access: () => (state.active ? access : null),
    revision: () => state.revision,
    visibility: () => ({ ...state.visibility }),
    shares: () => [share],
    owner: () => ({ displayName: 'Owner', avatarUrl: null }),
    history: vi.fn(async () => history),
    quota: vi.fn(async () => ({
      group: false,
      partial: false,
      accounts: [
        {
          state: 'ready' as const,
          updatedAt: 1,
          windows: [],
          balance: {
            remaining: 0,
            total: 100,
            currency: 'USD' as const,
            resetsAt: null,
            pools: [],
          },
        },
      ],
    })),
  };
  return { state, deps, history, read: createProviderShareInsightsReader(deps) };
}
const request = { version: 1 };
describe('provider share insights', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('honors quota=%s usage=%s independently', async (quota, usage) => {
    const { state, deps, read } = fixture();
    state.visibility = { quota, usage, revision: 0 };
    const view = await read('peer', request);
    expect(view.capabilities).toEqual({ quota, usage });
    expect(view.quota !== null).toBe(quota);
    expect(view.usage !== null).toBe(usage);
    expect(deps.quota).toHaveBeenCalledTimes(Number(quota));
    expect(deps.history).toHaveBeenCalledTimes(Number(usage));
  });
  it('includes relayed totals without topology, private notes, or deleted members', async () => {
    const { read } = fixture();
    const view = await read('peer', request);
    expect(
      view.usage?.parties.map((p) => [
        p.key === 'relay' ? 'relay' : p.displayName,
        p.days[0]?.inputTokens,
      ]),
    ).toEqual([
      ['Owner', 10],
      ['Alice', 10],
      ['relay', 20],
    ]);
    expect(view.usage?.parties[1].isYou).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(
      /private-|Secret Computer|Other Computer|deleted|memberId|deviceId|memberKey|providerId/,
    );
    expect(parseProviderShareInsights(view)).toEqual(view);
  });
  it.each(['quota', 'usage'] as const)('keeps the other capability when %s fails', async (key) => {
    const { deps, read } = fixture();
    if (key === 'quota') deps.quota.mockRejectedValue(new Error('upstream failed'));
    else deps.history.mockRejectedValue(new Error('ledger failed'));
    const view = await read('peer', request);
    expect(view.status[key]).toBe('unavailable');
    expect(view[key]).toBeNull();
    expect(view[key === 'quota' ? 'usage' : 'quota']).not.toBeNull();
  });
  it.each(['visibility', 'membership', 'owner'] as const)(
    'rejects in-flight results after %s changes',
    async (change) => {
      const { state, deps, read } = fixture();
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const history = await deps.history();
      deps.history.mockImplementation(async () => {
        await wait;
        return history;
      });
      const pending = read('peer', request);
      if (change === 'visibility') state.visibility.revision += 2;
      if (change === 'membership') state.revision += 2;
      if (change === 'owner') state.owner = 'b';
      finish();
      await expect(pending).rejects.toThrow();
    },
  );
  it('invalidates completed results after closing/reopening and never trusts foreign objects', async () => {
    const { read, state } = fixture();
    const view = await read('peer', request);
    expect(read.isCurrent('peer', view)).toBe(true);
    expect(read.isCurrent('other-peer', view)).toBe(false);
    expect(read.isCurrent('peer', { ...view })).toBe(false);
    state.visibility.revision += 2;
    expect(read.isCurrent('peer', view)).toBe(false);
  });
  it('shares cached history within an owner but reloads for another owner with the same provider id', async () => {
    const { read, deps, state } = fixture();
    await read('peer', request);
    await read('peer', request);
    expect(deps.history).toHaveBeenCalledTimes(1);
    state.owner = 'b';
    await read('peer', request);
    expect(deps.history).toHaveBeenCalledTimes(2);
  });
  it('retains each provider history and coalesces only that provider while reads are in flight', async () => {
    const { deps, history } = fixture();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const load = vi.fn(async (providerId: string) => {
      await wait;
      return { ...history, self: { ...history.self, days: [{ ...day, model: providerId }] } };
    });
    const read = createProviderShareInsightsReader({
      ...deps,
      access: (peer) => ({ ...deps.access()!, providerId: peer, shareId: peer }),
      shares: () => ['a', 'b'].map((id) => ({ ...deps.shares()[0], providerId: id, shareId: id })),
      history: load,
    });
    const pending = ['a', 'b', 'a', 'b'].map((peer) => read(peer, request));
    finish();
    const views = await Promise.all(pending);
    expect(views.map((view) => view.usage?.parties[0].days[0].model)).toEqual(['a', 'b', 'a', 'b']);
    await read('a', request);
    await read('b', request);
    expect(load.mock.calls).toEqual([['a'], ['b']]);
    // A failing retry must not remove B's still-current history.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);
    await read('b', request);
    load.mockRejectedValueOnce(new Error('ledger failed'));
    expect((await read('a', request)).status.usage).toBe('unavailable');
    await read('a', request);
    await read('b', request);
    expect(load.mock.calls).toEqual([['a'], ['b'], ['b'], ['a'], ['a']]);
  });
  it.each(['expiry', 'membership', 'visibility'] as const)(
    'reloads cached history after %s changes',
    async (change) => {
      const { read, deps, state } = fixture();
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      await read('peer', request);
      if (change === 'expiry') now.mockReturnValue(16_000);
      if (change === 'membership') state.revision += 1;
      if (change === 'visibility') state.visibility.revision += 2;
      await read('peer', request);
      await read('peer', request);
      expect(deps.history).toHaveBeenCalledTimes(2);
    },
  );
  it('does not let an expired in-flight failure evict its successful replacement', async () => {
    const { read, deps } = fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    let fail!: (error: Error) => void;
    deps.history.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const old = read('peer', request);
    now.mockReturnValue(16_000);
    expect((await read('peer', request)).status.usage).toBe('ready');
    fail(new Error('old failure'));
    expect((await old).status.usage).toBe('unavailable');
    expect((await read('peer', request)).status.usage).toBe('ready');
    expect(deps.history).toHaveBeenCalledTimes(2);
  });
  it('budgets final member metadata and quota together with newest usage rows', async () => {
    const { deps, history } = fixture();
    const share = deps.shares()[0];
    share.members = Array.from({ length: 1_200 }, (_, index) => ({
      ...share.members[0],
      memberId: String(index),
      displayName: '名字'.repeat(40),
      avatarUrl: 'https://example.com/' + 'a'.repeat(600),
    }));
    history.self.days = Array.from({ length: 750 }, (_, index) => ({
      ...day,
      day: index < 375 ? '2026-10-18' : '2026-10-19',
      model: '模型'.repeat(300) + index,
    }));
    history.members = [];
    history.relays = [];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
    const read = createProviderShareInsightsReader({ ...deps, shares: () => [share] });
    const result = await read('peer', request);
    const frame = {
      v: 1,
      kind: 'invoke-result',
      id: 'request',
      dst: 'peer',
      payload: { ok: true, result },
    };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_FRAME_BYTES);
    expect(result.status).toEqual({ quota: 'ready', usage: 'ready' });
    expect(result.usage?.parties).toHaveLength(1_201);
    const kept = result.usage!.parties[0].days;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(750);
    expect(kept.map((row) => row.model)).toEqual(
      [...history.self.days]
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, kept.length)
        .map((row) => row.model),
    );
    expect(result.usage?.coverageStart).toBe(kept.at(-1)?.day);
    expect(parseProviderShareInsights(result)).toEqual(result);
    expect(read.isCurrent('peer', result)).toBe(true);
  });
  it('keeps quota available when member metadata alone exceeds the frame budget', async () => {
    const { deps } = fixture();
    const share = deps.shares()[0];
    share.members = Array.from({ length: 10_000 }, (_, index) => ({
      ...share.members[0],
      memberId: String(index),
      displayName: '名字'.repeat(40),
    }));
    const read = createProviderShareInsightsReader({ ...deps, shares: () => [share] });
    const result = await read('peer', request);
    expect(result.status).toEqual({ quota: 'ready', usage: 'unavailable' });
    expect(result.usage).toBeNull();
    expect(result.quota?.accounts[0].balance?.remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
  });
  it('keeps usage available when the quota projection alone exceeds the frame budget', async () => {
    const { deps } = fixture();
    const quota = await deps.quota();
    const read = createProviderShareInsightsReader({
      ...deps,
      quota: async () => ({
        ...quota,
        accounts: Array.from({ length: 512 }, () => ({
          ...quota.accounts[0],
          windows: Array.from({ length: 32 }, () => ({
            kind: 'scoped' as const,
            label: '窗口'.repeat(64),
            remainingPercent: 50,
            resetsAt: null,
            windowMinutes: null,
          })),
        })),
      }),
    });
    const result = await read('peer', request);
    expect(result.status).toEqual({ quota: 'unavailable', usage: 'ready' });
    expect(result.quota).toBeNull();
    expect(result.usage?.parties[0].days[0].inputTokens).toBe(10);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_FRAME_BYTES - 1_024);
  });
  it('rejects unauthorized members and a guest-supplied provider id', async () => {
    const { read, state } = fixture();
    await expect(read('peer', { version: 1, providerId: 'other' })).rejects.toThrow(
      'INVALID_PARAMS',
    );
    state.active = false;
    await expect(read('peer', request)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('strips unknown fields and ignores data for disabled capabilities on the receiving boundary', async () => {
    const { read } = fixture();
    const view = await read('peer', request);
    expect(parseProviderShareInsights({ ...view, version: 2 })).toBeNull();
    expect(parseProviderShareInsights({ version: 1, capabilities: view.capabilities })).toBeNull();
    const parsed = parseProviderShareInsights({
      ...view,
      secret: 'no',
      capabilities: { quota: false, usage: false },
    });
    expect(parsed).toMatchObject({
      quota: null,
      usage: null,
      status: { quota: 'disabled', usage: 'disabled' },
    });
    expect(parsed).not.toHaveProperty('secret');
  });
});
