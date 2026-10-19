import { describe, expect, it, vi } from 'vitest';
import type { ProviderShareOwned } from '@cindy/device-link';
import type { ProviderUsageHistoryView } from '../../../shared/providerShare';
import { parseProviderShareInsights } from '../../../shared/providerShareInsights';
import { createProviderShareInsightsReader } from '../providerShareInsights';

/* 测试价值：通过新只读 reader 验证四种能力组合、匿名投影、独立失败和撤权时序。
 * 依据：provider-sharing 的最小范围及账号隔离；旧 dispatch/management 测试没有新 reader。
 * 最小失败输入：一项查询失败、在途关闭后重开、同 providerId 换账号、转来的一行用量。
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
  return { state, deps, read: createProviderShareInsightsReader(deps) };
}
const request = { version: 1 };
describe('provider share insights', () => {
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
