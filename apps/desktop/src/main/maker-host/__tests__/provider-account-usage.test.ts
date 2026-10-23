import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentKind, Provider } from '@cindy/model-providers';

import {
  isZhipuCodingPlanProvider,
  parseDeepSeekAccountUsage,
  readProviderAccountUsage,
  resetProviderAccountUsageForTest,
  resolveProviderAccountUsage,
  setAccountUsageFetch,
  setAccountUsageKeyReader,
  setAccountUsageNow,
  setAccountUsageOwnerStampReader,
  setAccountUsageProviderReader,
} from '../provider-account-usage.js';

function mkProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    source: 'user',
    agents: ['claude-code', 'codex', 'pi'],
    auth: { method: 'apiKey' },
    routing: {
      'claude-code': { upstream: 'https://api.deepseek.com/anthropic', authStrategy: 'api-key-header' as const },
      codex: { upstream: 'https://api.deepseek.com', authStrategy: 'api-key-header' as const },
      pi: { upstream: 'https://api.deepseek.com', authStrategy: 'api-key-header' as const },
    },
    models: {},
    ...overrides,
  } as Provider;
}

const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '194.06',
      granted_balance: '0.00',
      topped_up_balance: '194.06',
    },
  ],
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

let nowMs = 1_000_000;

describe('parseDeepSeekAccountUsage', () => {
  it('keeps all documented balance fields and currencies', () => {
    const snapshot = parseDeepSeekAccountUsage(
      {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
          { currency: 'USD', total_balance: '1.25', granted_balance: '0.25', topped_up_balance: '1.00' },
        ],
      },
      42,
    );
    expect(snapshot).toEqual({
      kind: 'deepseek-balance',
      isAvailable: true,
      fetchedAt: 42,
      balances: [
        { currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.00', toppedUpBalance: '10.34' },
        { currency: 'USD', totalBalance: '1.25', grantedBalance: '0.25', toppedUpBalance: '1.00' },
      ],
    });
  });

  it('rejects malformed payloads', () => {
    expect(() => parseDeepSeekAccountUsage({ is_available: true }, 1)).toThrow(/invalid/);
    expect(() =>
      parseDeepSeekAccountUsage({ is_available: true, balance_infos: [{}] }, 1),
    ).toThrow(/invalid/);
    expect(() =>
      parseDeepSeekAccountUsage(
        { is_available: 'yes', balance_infos: [] },
        1,
      ),
    ).toThrow(/invalid/);
    // 非十进制字符串（如科学计数 / 注入）不得进入展示层。
    expect(() =>
      parseDeepSeekAccountUsage(
        {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '1e3', granted_balance: '0', topped_up_balance: '0' }],
        },
        1,
      ),
    ).toThrow(/invalid/);
  });
});

describe('resolveProviderAccountUsage', () => {
  beforeEach(() => {
    resetProviderAccountUsageForTest();
  });

  it('claims official deepseek origin api-key providers with any runtime key', () => {
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((providerId, agent) =>
      providerId === 'deepseek' && agent === 'claude-code' ? 'sk-test' : null,
    );
    expect(resolveProviderAccountUsage('deepseek')).toMatchObject({
      integrationId: 'deepseek-balance-v1',
      endpoint: 'https://api.deepseek.com/user/balance',
      agent: 'claude-code',
      key: 'sk-test',
    });
  });

  it('falls through to a later runtime when the first has no key', () => {
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((_id, agent) => (agent === 'pi' ? 'sk-pi' : null));
    expect(resolveProviderAccountUsage('deepseek')?.agent).toBe('pi');
  });

  it('never claims proxied base URLs or oauth providers', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        routing: { 'claude-code': { upstream: 'https://proxy.example/v1', authStrategy: 'api-key-header' as const } },
      }),
    );
    setAccountUsageKeyReader(() => 'sk-test');
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();

    setAccountUsageProviderReader(() =>
      mkProvider({ auth: { method: 'oauth' as const } }),
    );
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();
  });

  it('rejects lookalike hosts (exact origin match only)', () => {
    setAccountUsageProviderReader(() =>
      mkProvider({
        routing: { 'claude-code': { upstream: 'https://api.deepseek.com.evil.com/anthropic', authStrategy: 'api-key-header' as const } },
      }),
    );
    setAccountUsageKeyReader(() => 'sk-test');
    expect(resolveProviderAccountUsage('deepseek')).toBeNull();
  });
});

describe('isZhipuCodingPlanProvider', () => {
  beforeEach(() => resetProviderAccountUsageForTest());

  it('detects coding-plan endpoints and the builtin preset id, not pay-as-you-go', () => {
    const coding = mkProvider({
      id: 'glm-coding-plan',
      routing: {
        'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' as const },
        codex: { upstream: 'https://open.bigmodel.cn/api/coding/paas/v4', authStrategy: 'api-key-header' as const },
      },
    });
    expect(isZhipuCodingPlanProvider(coding)).toBe(true);
    expect(isZhipuCodingPlanProvider(mkProvider({ id: 'zhipu-coding-plan-cn' }))).toBe(true);
    const payg = mkProvider({
      id: 'zhipu-glm',
      routing: { codex: { upstream: 'https://open.bigmodel.cn/api/paas/v4', authStrategy: 'api-key-header' as const } },
    });
    expect(isZhipuCodingPlanProvider(payg)).toBe(false);
    expect(isZhipuCodingPlanProvider(undefined)).toBe(false);
  });
});

describe('readProviderAccountUsage', () => {
  beforeEach(() => {
    resetProviderAccountUsageForTest();
    nowMs = 1_000_000;
    setAccountUsageNow(() => nowMs);
    setAccountUsageOwnerStampReader(() => ({ dataOwnerId: 'owner-a', generation: 1 }));
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader(() => 'sk-test');
  });

  afterEach(() => {
    resetProviderAccountUsageForTest();
    vi.restoreAllMocks();
  });

  it('returns unsupported when no official route exists', async () => {
    setAccountUsageProviderReader(() =>
      mkProvider({ routing: { 'claude-code': { upstream: 'https://proxy.example/v1', authStrategy: 'api-key-header' as const } } }),
    );
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toEqual({ status: 'unsupported' });
  });

  it('reports no-credentials when the official route exists without a key', async () => {
    setAccountUsageKeyReader(() => null);
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toEqual({ status: 'unavailable', error: 'no-credentials' });
  });

  it('fetches with bearer auth and returns a ready snapshot', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.deepseek.com/user/balance');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
      return jsonRes(DEEPSEEK_BALANCE);
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(result).toEqual({
      status: 'ready',
      stale: false,
      snapshot: {
        kind: 'deepseek-balance',
        isAvailable: true,
        balances: [
          { currency: 'CNY', totalBalance: '194.06', grantedBalance: '0.00', toppedUpBalance: '194.06' },
        ],
        fetchedAt: nowMs,
      },
    });
  });

  it('serves the cached snapshot inside the TTL and refetches after expiry', async () => {
    const fetchMock = vi.fn(async () => jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    nowMs += 6 * 60_000;
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps upstream failures to error codes and keeps stale snapshots', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonRes(DEEPSEEK_BALANCE);
      return jsonRes({ error: 'bad key' }, 401);
    });
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const first = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(first.status).toBe('ready');
    nowMs += 6 * 60_000;
    const second = await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(second).toMatchObject({ status: 'ready', stale: true, error: 'auth' });
    expect((second as { snapshot: { balances: unknown[] } }).snapshot.balances).toHaveLength(1);
  });

  it('rate-limited manual refresh reports throttled', async () => {
    const fetchMock = vi.fn(async () => jsonRes({}, 429, { 'retry-after': '30' }));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    const result = await readProviderAccountUsage({ providerId: 'deepseek', forceRefresh: true });
    expect(result).toMatchObject({ status: 'unavailable', error: 'throttled' });
  });

  it('invalidates the cache when the owner stamp changes', async () => {
    const fetchMock = vi.fn(async () => jsonRes(DEEPSEEK_BALANCE));
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await readProviderAccountUsage({ providerId: 'deepseek' });
    setAccountUsageOwnerStampReader(() => ({ dataOwnerId: 'owner-b', generation: 2 }));
    await readProviderAccountUsage({ providerId: 'deepseek' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies invalid JSON as invalid-response', async () => {
    const fetchMock = vi.fn(
      async () => new Response('<html>gateway login</html>', { status: 200 }),
    );
    setAccountUsageFetch(fetchMock as unknown as typeof fetch);
    await expect(
      readProviderAccountUsage({ providerId: 'deepseek' }),
    ).resolves.toMatchObject({ status: 'unavailable', error: 'invalid-response' });
  });
});

describe('provider runtime key order', () => {
  it('queries claude-code before codex before pi', async () => {
    resetProviderAccountUsageForTest();
    const seen: AgentKind[] = [];
    setAccountUsageProviderReader(() => mkProvider());
    setAccountUsageKeyReader((_id, agent) => {
      seen.push(agent);
      return agent === 'codex' ? 'sk-codex' : null;
    });
    expect(resolveProviderAccountUsage('deepseek')?.agent).toBe('codex');
    expect(seen).toEqual(['claude-code', 'codex']);
  });
});
