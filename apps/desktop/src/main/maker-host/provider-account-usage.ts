/**
 * provider-account-usage —— API Key 供应商账户余额查询（设置页余额卡的数据源）。
 *
 * 设计要点：
 *   - **端点钉死在 main**：integration 表是硬编码的官方端点（deepseek →
 *     `https://api.deepseek.com/user/balance`）。renderer 只传 providerId，不传 URL；
 *     key 只发给官方端点，永远不会发到用户配置的第三方代理。
 *   - **按官方 origin 认领**：只有当供应商某个 runtime 的 baseUrl origin 与官方端点
 *     origin 一致且鉴权方式是 apiKey 时才启用。走代理 / 自定义域名的连接不查（key 属于
 *     代理，不属于官方账户）；这也让官方预设创建的老连接无需迁移就能直接生效。
 *   - **key 读取器注入**：同 provider-diagnostics 的 setDiagnosticsKeyReader 模式，模块
 *     不直接 import safeStorage（maker-host 不触电 Electron），host 注册期接通。
 *   - 查询型结果：失败不 throw，映射为 ProviderAccountUsageError（规则 13 例外条款）。
 *   - 缓存：TTL 5 分钟内存缓存；手动刷新受 15s 节流；账号切换（owner / generation 变化）
 *     整体失效。缓存键含 providerId + agent，换 runtime 配置不串数据。
 */

import type { AgentKind, Provider } from '@cindy/model-providers';

import {
  PROVIDER_ACCOUNT_USAGE_AGENTS,
  type DeepSeekAccountUsageSnapshot,
  type ProviderAccountUsageError,
  type ProviderAccountUsageRequest,
  type ProviderAccountUsageResult,
} from '../../shared/providerAccountUsage.js';
import { createMakerLogger } from './logger-adapter.js';

const log = createMakerLogger('provider-account-usage');

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const MIN_MANUAL_REFRESH_INTERVAL_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** 官方账户接口清单。端点是唯一事实源，不从目录 / 用户配置推导。 */
const INTEGRATIONS = {
  'deepseek-balance-v1': {
    origin: 'https://api.deepseek.com',
    endpoint: 'https://api.deepseek.com/user/balance',
  },
} as const;

export type ProviderAccountUsageIntegrationId = keyof typeof INTEGRATIONS;

/** 该供应商是否命中智谱 GLM Coding Plan 的官方接入端点（设置页给「查看套餐用量」入口用）。 */
export function isZhipuCodingPlanProvider(provider: Provider | undefined | null): boolean {
  if (!provider) return false;
  if (provider.id === 'zhipu-coding-plan-cn') return true;
  return Object.values(provider.routing).some((route) => {
    const upstream = route?.upstream;
    if (!upstream) return false;
    return (
      upstream === 'https://open.bigmodel.cn/api/anthropic'
      || upstream.startsWith('https://open.bigmodel.cn/api/coding/')
    );
  });
}

export interface ProviderAccountUsageResolution {
  integrationId: ProviderAccountUsageIntegrationId;
  endpoint: string;
  /** key 所属 runtime；与缓存键一起区分不同 runtime 的 key。 */
  agent: AgentKind;
  key: string;
}

type ProviderReader = (providerId: string) => Provider | undefined;
type KeyReader = (providerId: string, agent: AgentKind) => string | null;
type OwnerStampReader = () => { dataOwnerId: string | null; generation: number };

let providerReader: ProviderReader = () => undefined;
let keyReader: KeyReader = () => null;
let ownerStampReader: OwnerStampReader = () => ({ dataOwnerId: null, generation: 0 });
let fetchImpl: typeof fetch = globalThis.fetch;

/** host 注册期接通真实目录读取（active-catalog）。 */
export function setAccountUsageProviderReader(reader: ProviderReader): void {
  providerReader = reader;
}

/** host 注册期接通真实 safeStorage key 读取（provider_key_<id>_<agent>）。 */
export function setAccountUsageKeyReader(reader: KeyReader): void {
  keyReader = reader;
}

/** host 注册期接通账号身份戳（缓存隔离用）。 */
export function setAccountUsageOwnerStampReader(reader: OwnerStampReader): void {
  ownerStampReader = reader;
}

/** 测试注入 fetch。 */
export function setAccountUsageFetch(impl: typeof fetch): void {
  fetchImpl = impl;
}

/** 测试注入时钟。 */
export let accountUsageNow: () => number = Date.now;

export function setAccountUsageNow(now: () => number): void {
  accountUsageNow = now;
}

interface CacheRecord {
  snapshot?: DeepSeekAccountUsageSnapshot;
  expiresAt: number;
  lastAttemptAt: number;
  lastError?: ProviderAccountUsageError;
  retryAt: number;
}

const cache = new Map<string, CacheRecord>();

class AccountUsageRequestError extends Error {
  constructor(
    readonly code: ProviderAccountUsageError,
    readonly retryAt?: number,
  ) {
    super(code);
  }
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
}

/** 解析并校验 DeepSeek `/user/balance` 响应；字段缺失 / 形状不符直接抛错（invalid-response）。 */
export function parseDeepSeekAccountUsage(
  value: unknown,
  fetchedAt: number,
): DeepSeekAccountUsageSnapshot {
  const fail = (): never => {
    throw new Error('invalid DeepSeek balance response');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const payload = value as Record<string, unknown>;
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    return fail();
  }
  const balances = payload.balance_infos.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail();
    const line = candidate as Record<string, unknown>;
    if (
      typeof line.currency !== 'string'
      || line.currency.trim().length === 0
      || line.currency.length > 16
      || !isDecimalString(line.total_balance)
      || !isDecimalString(line.granted_balance)
      || !isDecimalString(line.topped_up_balance)
    ) {
      return fail();
    }
    return {
      currency: line.currency,
      totalBalance: line.total_balance,
      grantedBalance: line.granted_balance,
      toppedUpBalance: line.topped_up_balance,
    };
  });
  return { kind: 'deepseek-balance', isAvailable: payload.is_available, balances, fetchedAt };
}

/**
 * 认领规则：apiKey 鉴权 + 某 runtime 的 baseUrl origin 与官方端点 origin 全等。
 * https 之外一律不认领（规则同 provider-route 的上游判定，不做子串包含）。
 */
export function resolveProviderAccountUsage(
  providerId: string,
): ProviderAccountUsageResolution | null {
  const provider = providerReader(providerId);
  if (!provider || provider.auth.method !== 'apiKey') return null;
  for (const [integrationId, integration] of Object.entries(INTEGRATIONS) as [
    ProviderAccountUsageIntegrationId,
    (typeof INTEGRATIONS)[ProviderAccountUsageIntegrationId],
  ][]) {
    for (const agent of PROVIDER_ACCOUNT_USAGE_AGENTS) {
      const upstream = provider.routing[agent]?.upstream;
      if (!upstream) continue;
      let matches = false;
      try {
        const url = new URL(upstream);
        matches = url.protocol === 'https:' && url.origin === integration.origin;
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const key = keyReader(providerId, agent)?.trim();
      if (!key) continue;
      return { integrationId, endpoint: integration.endpoint, agent, key };
    }
  }
  return null;
}

/** key 归属该 provider 的哪个 runtime 都不关键；余额接口对全账号生效，取任一可用 key。 */
export function providerAccountUsageSupported(providerId: string): boolean {
  const provider = providerReader(providerId);
  if (!provider || provider.auth.method !== 'apiKey') return false;
  return Object.entries(INTEGRATIONS).some(([, integration]) =>
    PROVIDER_ACCOUNT_USAGE_AGENTS.some((agent) => {
      const upstream = provider.routing[agent]?.upstream;
      if (!upstream) return false;
      try {
        return new URL(upstream).protocol === 'https:' && new URL(upstream).origin === integration.origin;
      } catch {
        return false;
      }
    }),
  );
}

function mapHttpStatusToError(status: number): ProviderAccountUsageError | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return null;
}

function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return now + Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function fetchDeepSeekBalance(
  resolution: ProviderAccountUsageResolution,
): Promise<DeepSeekAccountUsageSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(resolution.endpoint, {
      headers: { Authorization: `Bearer ${resolution.key}` },
      signal: controller.signal,
    });
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), accountUsageNow());
    const mapped = mapHttpStatusToError(response.status);
    if (mapped) throw new AccountUsageRequestError(mapped, retryAfterMs);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new AccountUsageRequestError('invalid-response');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AccountUsageRequestError('invalid-response');
    }
    try {
      return parseDeepSeekAccountUsage(payload, accountUsageNow());
    } catch {
      throw new AccountUsageRequestError('invalid-response');
    }
  } catch (err) {
    if (err instanceof AccountUsageRequestError) throw err;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new AccountUsageRequestError('network');
    }
    throw new AccountUsageRequestError('network');
  } finally {
    clearTimeout(timer);
  }
}

/** 查询入口：unsupported / unavailable / ready 三态。网络失败时回落过期快照（stale）。 */
export async function readProviderAccountUsage(
  request: ProviderAccountUsageRequest,
): Promise<ProviderAccountUsageResult> {
  const ownerStamp = ownerStampReader();
  const resolution = resolveProviderAccountUsage(request.providerId);
  if (!resolution) {
    // 没认领到官方端点，或 key 读不到。区分「本来就没有接口」与「有接口但 key 缺失」。
    if (providerAccountUsageSupported(request.providerId)) {
      return { status: 'unavailable', error: 'no-credentials' };
    }
    return { status: 'unsupported' };
  }
  const cacheKey = `${ownerStamp.dataOwnerId ?? 'local'}:${ownerStamp.generation}:${request.providerId}:${resolution.integrationId}`;
  const now = accountUsageNow();
  const record = cache.get(cacheKey);
  const manualRefreshBlocked =
    request.forceRefresh === true
    && record !== undefined
    && now - record.lastAttemptAt < MIN_MANUAL_REFRESH_INTERVAL_MS;
  if (manualRefreshBlocked && record.snapshot && record.expiresAt > now) {
    return { status: 'ready', snapshot: record.snapshot, stale: false };
  }
  if (
    !request.forceRefresh
    && record?.snapshot
    && record.expiresAt > now
    && record.lastError === undefined
  ) {
    return { status: 'ready', snapshot: record.snapshot, stale: false };
  }
  try {
    const snapshot = await fetchDeepSeekBalance(resolution);
    cache.set(cacheKey, {
      snapshot,
      expiresAt: accountUsageNow() + CACHE_TTL_MS,
      lastAttemptAt: accountUsageNow(),
      retryAt: 0,
    });
    return { status: 'ready', snapshot, stale: false };
  } catch (err) {
    const code = err instanceof AccountUsageRequestError ? err.code : 'unknown';
    log.warn(
      'provider account usage fetch failed',
      { providerId: request.providerId, integrationId: resolution.integrationId, code },
    );
    if (err instanceof AccountUsageRequestError && err.retryAt) {
      cache.set(cacheKey, {
        snapshot: record?.snapshot,
        expiresAt: record?.expiresAt ?? 0,
        lastAttemptAt: now,
        lastError: code,
        retryAt: err.retryAt,
      });
    } else {
      cache.set(cacheKey, {
        snapshot: record?.snapshot,
        expiresAt: record?.expiresAt ?? 0,
        lastAttemptAt: now,
        lastError: code,
        retryAt: 0,
      });
    }
    if (
      err instanceof AccountUsageRequestError
      && err.code === 'rate-limited'
      && request.forceRefresh
    ) {
      return { status: 'unavailable', error: 'throttled', retryAt: err.retryAt };
    }
    const fallback = record?.snapshot;
    if (fallback) {
      return { status: 'ready', snapshot: fallback, stale: true, error: code };
    }
    return { status: 'unavailable', error: code };
  }
}

/** 测试辅助：清空缓存与注入重置。 */
export function resetProviderAccountUsageForTest(): void {
  cache.clear();
  providerReader = () => undefined;
  keyReader = () => null;
  ownerStampReader = () => ({ dataOwnerId: null, generation: 0 });
  fetchImpl = globalThis.fetch;
  accountUsageNow = Date.now;
}
