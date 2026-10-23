/**
 * providerAccountUsage —— API Key 计费供应商的账户余额 / 用量快照（renderer ↔ main 共享形状）。
 *
 * 与订阅制（Claude / Codex / xAI）的 `providerQuotaSource` 互补：那边读的是 OAuth 订阅的
 * 周期配额（5h / 7d 窗口），这边读的是 API Key 供应商自己的账户接口（如 DeepSeek
 * `/user/balance`）。两者互不借用：订阅卡与余额卡各自成立，缺一不显示另一张。
 *
 * 结果是查询型结构化返回（规则 13 例外条款）：网络 / 上游 / 鉴权失败不 throw，落进
 * `error`，renderer 按 code 渲染分类文案与重试入口。快照本身不含任何密钥材料。
 */

import type { AgentKind } from '@cindy/model-providers';

export interface ProviderAccountUsageRequest {
  providerId: string;
  /** 手动刷新（设置页刷新按钮）。绕过 TTL 缓存但仍受最小间隔节流。 */
  forceRefresh?: boolean;
}

export interface DeepSeekBalanceLine {
  /** ISO 4217 货币码（如 CNY / USD）。 */
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekAccountUsageSnapshot {
  kind: 'deepseek-balance';
  isAvailable: boolean;
  balances: DeepSeekBalanceLine[];
  /** epoch ms。 */
  fetchedAt: number;
}

export type ProviderAccountUsageSnapshot = DeepSeekAccountUsageSnapshot;

export type ProviderAccountUsageError =
  | 'no-credentials'
  | 'updating'
  | 'auth'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'invalid-response'
  | 'throttled'
  | 'unknown';

export type ProviderAccountUsageResult =
  /** 该供应商没有可读的账户余额 / 用量接口（renderer 不渲染模块）。 */
  | { status: 'unsupported' }
  | { status: 'unavailable'; error: ProviderAccountUsageError; retryAt?: number }
  | {
      status: 'ready';
      snapshot: ProviderAccountUsageSnapshot;
      stale: boolean;
      error?: ProviderAccountUsageError;
      retryAt?: number;
    };

/**
 * 智谱 GLM Coding Plan 的官方用量页。套餐额度（5 小时 / 每周积分）只能在这页看：
 * 开放平台对 Coding Plan key 没有公开的余额 / 配额查询 API（2026-10 实测 + 官方文档
 * 「积分额度」节指引），余额接口对 Coding key 也是 404。因此 GLM Coding Plan 不做余额
 * 拉取，只给这个入口。
 */
export const ZHIPU_CODING_PLAN_USAGE_URL = 'https://www.bigmodel.cn/coding-plan/personal/usage';

/** 余额查询优先用的 runtime 顺序（与用户实际配置密度对齐，命中即止）。 */
export const PROVIDER_ACCOUNT_USAGE_AGENTS: readonly AgentKind[] = [
  'claude-code',
  'codex',
  'pi',
];
