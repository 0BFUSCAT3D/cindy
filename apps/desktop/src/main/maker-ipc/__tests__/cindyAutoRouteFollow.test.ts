import { describe, expect, it, vi } from 'vitest';

import type { CatalogModel, ProviderSource, ProviderView } from '@cindy/model-providers';

import {
  followMovedCindyAutoRoutes,
  movedCindyAutoProviderId,
  type CindyAutoRoute,
  type CindyAutoRouteFollowDeps,
} from '../cindyAutoRouteFollow.js';

const AUTO = 'auto/group-1';

function model(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null };
}

function provider(id: string, source: ProviderSource, modelIds: string[]): ProviderView {
  return {
    id,
    name: id,
    source,
    agents: ['pi'],
    auth: { method: source === 'user' ? 'apiKey' : 'managed' },
    access: source === 'user' ? { kind: 'api' } : { kind: 'managed' },
    routing: { pi: { upstream: `https://${id}.test`, authStrategy: 'api-key-header' } },
    models: { pi: modelIds.map(model) },
    connected: true,
  };
}

const route = (patch: Partial<CindyAutoRoute> = {}): CindyAutoRoute => ({
  agentKind: 'pi',
  model: AUTO,
  providerId: 'org-pool',
  effort: 'high',
  fastMode: false,
  ...patch,
});

/** 管理员把 Auto 的目标从号池模型切到平台模型。 */
const movedToPlatform = [
  provider('xd', 'builtin', ['auto', AUTO]),
  provider('org-pool', 'organization', ['pool-model']),
];

describe('movedCindyAutoProviderId', () => {
  it('Auto 换了 Cindy 来源时给出新来源，引擎与模型不在这里改', () => {
    expect(movedCindyAutoProviderId(movedToPlatform, route())).toBe('xd');
    const movedToPool = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', [AUTO])];
    expect(movedCindyAutoProviderId(movedToPool, route({ providerId: 'xd' }))).toBe('org-pool');
  });

  it('Pi 的默认来源（providerId=null）就是 Cindy AI，Auto 挪到号池同样跟随', () => {
    const movedToPool = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', [AUTO])];
    expect(movedCindyAutoProviderId(movedToPool, route({ providerId: null }))).toBe('org-pool');
    // 其它引擎的默认来源不一定是 Cindy AI，不推断。
    expect(movedCindyAutoProviderId(movedToPool, route({ providerId: null, agentKind: 'codex' }))).toBeNull();
  });

  it('订阅等内置非 Cindy AI 来源上的 auto/... 不跟随', () => {
    const subscription = [provider('openai', 'builtin', ['other']), provider('xd', 'builtin', [AUTO])];
    expect(movedCindyAutoProviderId(subscription, route({ providerId: 'openai' }))).toBeNull();
  });

  it('Auto 从两份目录都消失时不登记切换，保留原路由交给既有的来源失效提示', () => {
    const gone = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', ['pool-model'])];
    expect(movedCindyAutoProviderId(gone, route())).toBeNull();
    expect(movedCindyAutoProviderId(gone, route({ providerId: null }))).toBeNull();
  });

  it('回归：预设 auto 的任务不动', () => {
    expect(movedCindyAutoProviderId(movedToPlatform, route({ model: 'auto', providerId: null }))).toBeNull();
    expect(movedCindyAutoProviderId(movedToPlatform, route({ model: 'auto', providerId: 'xd' }))).toBeNull();
  });

  it('来源没变、普通模型、用户自己接的供应商都不动', () => {
    expect(movedCindyAutoProviderId(movedToPlatform, route({ providerId: 'xd' }))).toBeNull();
    expect(movedCindyAutoProviderId(movedToPlatform, route({ model: 'pool-model' }))).toBeNull();
    const userOwned = [provider('custom', 'user', ['other']), provider('xd', 'builtin', [AUTO])];
    expect(movedCindyAutoProviderId(userOwned, route({ providerId: 'custom' }))).toBeNull();
  });
});

describe('followMovedCindyAutoRoutes', () => {
  function deps(overrides: Partial<CindyAutoRouteFollowDeps> = {}) {
    const stage = vi.fn(async () => {});
    const withSessionLock = vi.fn(async (_sessionId: string, run: () => Promise<void>) => run());
    const base: CindyAutoRouteFollowDeps = {
      listCandidates: async () => [
        { sessionId: 'moved', ...route() },
        { sessionId: 'unchanged', ...route({ providerId: 'xd' }) },
        { sessionId: 'plain', ...route({ model: 'pool-model' }) },
      ],
      listProviders: async () => movedToPlatform,
      withSessionLock,
      readRoute: async (sessionId) =>
        sessionId === 'moved' ? route({ effort: 'medium', fastMode: true }) : route({ providerId: 'xd' }),
      stage,
      assertCurrent: () => {},
    };
    return { stage, withSessionLock, deps: { ...base, ...overrides } };
  }

  it('只为 Auto 被挪走的任务登记下一条消息前的切换：只换供应商，保留引擎、模型与档位', async () => {
    const { stage, withSessionLock, deps: input } = deps();
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(1);
    expect(withSessionLock).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith('moved', {
      agentKind: 'pi', model: AUTO, providerId: 'xd', effort: 'medium', fastMode: true,
    });
  });

  it('加锁后重读：已有登记的切换或运行时改道（readRoute 返回 null）时不覆盖', async () => {
    const { stage, deps: input } = deps({ readRoute: async () => null });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(0);
    expect(stage).not.toHaveBeenCalled();
  });

  it('没有候选任务时不读供应商目录', async () => {
    const listProviders = vi.fn(async () => movedToPlatform);
    const { deps: input } = deps({ listCandidates: async () => [], listProviders });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(0);
    expect(listProviders).not.toHaveBeenCalled();
  });

  it('单个任务登记失败只记日志，其余任务继续', async () => {
    const logger = { info: vi.fn() };
    const stage = vi.fn(async (sessionId: string) => {
      if (sessionId === 'first') throw new Error('window check failed');
    });
    const { deps: input } = deps({
      listCandidates: async () => [
        { sessionId: 'first', ...route() },
        { sessionId: 'second', ...route() },
      ],
      readRoute: async () => route(),
      stage,
      logger,
    });
    await expect(followMovedCindyAutoRoutes(input)).resolves.toBe(1);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Cindy Auto provider follow failed; task keeps its route',
      expect.objectContaining({ sessionId: 'first' }),
    );
  });

  it('账号切换后整批停止，不再改动下一个账号的任务', async () => {
    let current = true;
    const stage = vi.fn(async () => { current = false; });
    const { deps: input } = deps({
      listCandidates: async () => [
        { sessionId: 'first', ...route() },
        { sessionId: 'second', ...route() },
      ],
      readRoute: async () => route(),
      stage,
      assertCurrent: () => {
        if (!current) throw new Error('owner changed');
      },
    });
    await expect(followMovedCindyAutoRoutes(input)).rejects.toThrow('owner changed');
    expect(stage).toHaveBeenCalledTimes(1);
  });
});
