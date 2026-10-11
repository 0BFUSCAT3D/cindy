/**
 * 组内电脑的失败所有使用方共用一份(provider-groups.md §5，2026-10-11 用户要求：选电脑第一时间选到能用的，
 * 不再每次从不能用的那台开始试；组里都确认不能用就直接说都不能用)。
 */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupDirectory, ResolvedMemberState, ResolvedProviderGroupMember } from '../directory';
import {
  createProviderGroupRouter,
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_BACKOFF_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  PROVIDER_GROUP_PICK_QUICK_MS,
  PROVIDER_GROUP_SUSPECT_MS,
  type ProviderGroupPersistedCooling,
} from '../router';

const MODEL = 'claude-opus-5-5';

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(key: string, agentDeviceId: string): ProviderGroupMember {
  return { key, kind: 'device', agentDeviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
}

const A = member('device:a:anthropic', 'a');
const B = member('device:b:anthropic', 'b');
const START = 1_000_000;

function harness(options: { members?: ProviderGroupMember[]; strategy?: ProviderGroupConfig['strategy'] } = {}) {
  let now = START;
  const states = new Map<string, ResolvedMemberState>();
  const config: ProviderGroupConfig = { strategy: options.strategy ?? 'least', autoSwitch: true, members: options.members ?? [A, B] };
  let persisted: ProviderGroupPersistedCooling = {};
  const invalidate = vi.fn();
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => {
        const state = states.get(m.key) ?? 'ok';
        return state === 'ok' ? { member: m, label: m.key, state, view: view(m.providerId) } : { member: m, label: m.key, state };
      });
    },
    async listCandidates() {
      return [];
    },
    async readDeviceCatalog() {
      return [];
    },
    async probe() {
      return 'ok' as const;
    },
    memberLabel: (m) => m.key,
    invalidate,
  };
  const create = () => createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => ({}),
    isTurnRunning: () => false,
    coolingStore: {
      read: () => persisted,
      write: (value) => {
        persisted = value;
      },
    },
    now: () => now,
    random: () => 0,
  });
  const router = create();
  const pickFor = async (reporter?: string) => {
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, ...(reporter ? { reporter } : {}) });
    return pick.kind === 'member' ? pick.member.key : pick.kind;
  };
  return {
    router,
    create,
    states,
    invalidate,
    pickFor,
    persisted: () => persisted,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('provider group failures shared by every user of the group', () => {
  it('makes everyone skip a computer once any user finds it cannot run tasks, and says so at once when none can', async () => {
    const h = harness();
    // 最少占用：两台都空，本该选 A。
    expect(await h.pickFor()).toBe(A.key);
    h.router.noteFailure('anthropic', A.key, { cause: 'unavailable', reporter: 'laptop' });
    // 本机、报告它的那台、其他同账号电脑都直接选到 B。
    expect(await h.pickFor()).toBe(B.key);
    expect(await h.pickFor('laptop')).toBe(B.key);
    expect(await h.pickFor('desktop')).toBe(B.key);
    h.router.noteFailure('anthropic', B.key, { cause: 'auth' });
    // 组里都确认不能用：直接说都不能用，不再挨个去试。
    expect(await h.pickFor()).toBe('unavailable');
    const shown = await h.router.view('anthropic');
    expect(shown.members.map((m) => [m.key, m.state, m.reason])).toEqual([
      [A.key, 'cooling', 'failed'],
      [B.key, 'cooling', 'failed'],
    ]);
  });

  it('only makes the reporting user skip a computer that just could not be reached from there', async () => {
    const h = harness();
    h.router.noteFailure('anthropic', A.key, { cause: 'unavailable', reporter: 'laptop', connectionLost: true });
    expect(await h.pickFor('laptop')).toBe(B.key);
    expect(await h.pickFor('desktop')).toBe(A.key);
    expect(await h.pickFor()).toBe(A.key);
    // 下次选电脑时组所在电脑现读那台：真连不上就是离线，所有使用方都会避开。
    expect(h.invalidate).toHaveBeenCalledWith('a');
    expect((await h.router.view('anthropic', { reporter: 'laptop' })).members[0]).toMatchObject({ state: 'cooling', reason: 'failed' });
    expect((await h.router.view('anthropic')).members[0]).toMatchObject({ state: 'available' });
  });

  it('waits longer each time the same computer fails again, and tries it only after the others while it is suspect', async () => {
    const h = harness();
    const until = h.router.noteFailure('anthropic', A.key, { cause: 'unavailable' });
    expect(until).toBe(START + PROVIDER_GROUP_FAILURE_COOLDOWN_MS);
    // 同一阵子里几个任务一起撞上：不重复加码。
    expect(h.router.noteFailure('anthropic', A.key, { cause: 'unavailable' })).toBe(until);
    h.advance(PROVIDER_GROUP_FAILURE_COOLDOWN_MS + 1);
    // 避开期过了：B 有空位时仍先选 B(最少占用下 A 的运行数一直是 0，不会总被最先选中)。
    expect(h.router.isAvoided('anthropic', A.key)).toBe(false);
    expect(await h.pickFor()).toBe(B.key);
    // 又失败一次：避开得更久。
    const again = h.router.noteFailure('anthropic', A.key, { cause: 'unavailable' });
    expect(again - (START + PROVIDER_GROUP_FAILURE_COOLDOWN_MS + 1)).toBe(PROVIDER_GROUP_FAILURE_BACKOFF_MS[1]);
    // 一阵子没再失败：照常参与分配。
    h.advance(PROVIDER_GROUP_FAILURE_BACKOFF_MS[1] + PROVIDER_GROUP_SUSPECT_MS + 1);
    expect(await h.pickFor()).toBe(A.key);
  });

  it('forgets a failure once the computer comes back online, or once a session opens there', async () => {
    const h = harness();
    h.router.noteFailure('anthropic', A.key, { cause: 'unavailable' });
    h.states.set(A.key, 'offline');
    expect(await h.pickFor()).toBe(B.key);
    // 重新上线：清掉，马上又能分给它。
    h.states.delete(A.key);
    expect(await h.pickFor()).toBe(A.key);

    h.router.noteFailure('anthropic', A.key, { cause: 'unavailable' });
    h.router.noteWorking('anthropic', A.key);
    expect(await h.pickFor()).toBe(A.key);
    // 登录失效不因打开了会话就算好了。
    h.router.noteFailure('anthropic', A.key, { cause: 'auth' });
    h.router.noteWorking('anthropic', A.key);
    expect(await h.pickFor()).toBe(B.key);
  });

  it('remembers usage-limit cooldowns across restarts, and nothing else', async () => {
    const h = harness();
    const resetAt = START + 3 * 60 * 60_000;
    h.router.noteFailure('anthropic', A.key, { cause: 'usage-limit', until: resetAt });
    h.router.noteFailure('anthropic', B.key, { cause: 'unavailable' });
    expect(h.persisted()).toEqual({ anthropic: { [A.key]: resetAt } });
    const restarted = h.create();
    expect(restarted.isAvoided('anthropic', A.key)).toBe(true);
    expect(restarted.isAvoided('anthropic', B.key)).toBe(false);
    const [shownA] = (await restarted.view('anthropic')).members;
    expect(shownA).toMatchObject({ state: 'cooling', coolingUntil: resetAt });
    expect(shownA.reason).toBeUndefined();
    // 拿不到重置时刻时按默认时长。
    expect(h.router.noteFailure('anthropic', B.key, { cause: 'usage-limit' })).toBe(START + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS);
  });

  it('asks the directory not to wait for slow computers once one that can take the task is known', async () => {
    const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [A, B] };
    const resolveMembers = vi.fn<ProviderGroupDirectory['resolveMembers']>(async () => [
      // A 到点还没读完：这次按不能用算。
      { member: A, label: 'a', state: 'offline', pending: true },
      { member: B, label: 'b', state: 'ok', view: view('anthropic') },
    ]);
    const router = createProviderGroupRouter({
      directory: {
        resolveMembers,
        listCandidates: async () => [],
        readDeviceCatalog: async () => [],
        probe: async () => 'ok' as const,
        memberLabel: (m) => m.key,
        invalidate: () => undefined,
      },
      readGroup: () => config,
      listBindings: () => ({}),
      isTurnRunning: () => false,
      now: () => START,
      random: () => 0,
    });
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL });
    expect(pick).toMatchObject({ kind: 'member', member: { key: B.key } });
    const options = resolveMembers.mock.calls[0][2];
    expect(options?.quickMs).toBe(PROVIDER_GROUP_PICK_QUICK_MS);
    // 够用 = 能用、没失败过、没满。
    expect(options?.enough?.({ member: B, label: 'b', state: 'ok', view: view('anthropic') })).toBe(true);
    expect(options?.enough?.({ member: A, label: 'a', state: 'offline' })).toBe(false);
    // 没读完的那台不算「从不能用变回能用」，不会因此清掉它的失败记录。
    router.noteFailure('anthropic', A.key, { cause: 'unavailable' });
    resolveMembers.mockResolvedValueOnce([
      { member: A, label: 'a', state: 'ok', view: view('anthropic') },
      { member: B, label: 'b', state: 'ok', view: view('anthropic') },
    ]);
    await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL });
    expect(router.isAvoided('anthropic', A.key)).toBe(true);
  });
});
