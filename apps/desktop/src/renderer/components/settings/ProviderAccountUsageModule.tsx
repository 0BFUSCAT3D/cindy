/**
 * ProviderAccountUsageModule —— API Key 计费供应商的账户余额卡（设置 → 模型供应商详情）。
 *
 * 与订阅卡（QuotaHoverCard + providerWeeklyQuotaSource）互斥呈现：订阅制读 OAuth 周期
 * 配额，这里读供应商自己的账户接口（DeepSeek `/user/balance`）。账户余额对整个账号生效
 * （与 runtime 无关），因此一个供应商一张卡；查询用的 key 按 claude-code → codex → pi
 * 顺序取第一个指向官方端点的 runtime（main 侧同一口径，见 provider-account-usage.ts）。
 *
 * 智谱 GLM Coding Plan 没有公开的额度查询 API（官方只给网页用量页），这里只给
 * 「查看套餐用量」外链，不做任何余额拉取。两类内容都缺席时模块不渲染。
 */

import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import { ZHIPU_CODING_PLAN_USAGE_URL, type ProviderAccountUsageResult } from '../../../shared/providerAccountUsage';
import { isZhipuCodingPlanProviderView } from '../../lib/zhipuCodingPlan';
import { useProviderAccountUsage } from '../../hooks/useProviderAccountUsage';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';

function formatCurrency(value: string, currency: string, locale: string): string {
  try {
    const fractionLength = value.split('.')[1]?.replace(/0+$/, '').length ?? 0;
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    });
    const defaultDigits = formatter.resolvedOptions().minimumFractionDigits ?? 0;
    if (fractionLength > 20) return `${value} ${currency}`;
    // ECMA-402 允许直接 format 十进制字符串，避免先过 Number 再舍入。
    const precise = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: Math.max(defaultDigits, fractionLength),
    });
    return (precise.format as unknown as (input: string) => string)(value);
  } catch {
    return `${value} ${currency}`;
  }
}

function errorKey(error: string): string {
  return `providerAccountUsage.error.${error}`;
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-11 text-[var(--text-tertiary)]">{label}</p>
      <p className="mt-0.5 truncate text-13 font-medium tabular-nums text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  );
}

function BalanceBody({
  result,
  locale,
}: {
  result: Extract<ProviderAccountUsageResult, { status: 'ready' }>;
  locale: string;
}) {
  const { t } = useTranslation();
  const { snapshot } = result;
  if (snapshot.kind !== 'deepseek-balance') return null;
  if (!snapshot.isAvailable || snapshot.balances.length === 0) {
    return (
      <p className="mt-3 flex items-start gap-2 text-13 text-[var(--text-secondary)]">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning-fg)]" aria-hidden />
        <span>
          {t(
            snapshot.isAvailable
              ? 'providerAccountUsage.deepSeek.empty'
              : 'providerAccountUsage.deepSeek.unavailable',
          )}
        </span>
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      {snapshot.balances.map((balance) => (
        <div key={balance.currency} className="rounded-lg bg-[var(--surface-chip)] px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-12 font-medium text-[var(--text-secondary)]">
              {balance.currency}
            </span>
            <span className="text-16 font-medium tabular-nums text-[var(--text-primary)]">
              {formatCurrency(balance.totalBalance, balance.currency, locale)}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <UsageMetric
              label={t('providerAccountUsage.deepSeek.granted')}
              value={formatCurrency(balance.grantedBalance, balance.currency, locale)}
            />
            <UsageMetric
              label={t('providerAccountUsage.deepSeek.toppedUp')}
              value={formatCurrency(balance.toppedUpBalance, balance.currency, locale)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** API Key 供应商的账户余额 / 用量入口卡。两类内容都缺席时返回 null。 */
export function ProviderAccountUsageModule({ provider }: { provider?: ProviderView }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const usage = useProviderAccountUsage(provider);
  const zhipuUsageLink = isZhipuCodingPlanProviderView(provider);
  const showBalance = usage.supported;
  if (!showBalance && !zhipuUsageLink) return null;
  const { result, busy } = usage;

  return (
    <div
      data-testid="provider-account-usage-module"
      className="border-t border-[var(--settings-theme-card-border)] px-5 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-12 font-medium text-[var(--settings-section-title)]">
          {t('providerAccountUsage.title')}
        </span>
        {showBalance && (
          <Tip text={t('providerAccountUsage.refresh')} side="top">
            <button
              type="button"
              aria-label={t('providerAccountUsage.refresh')}
              disabled={busy}
              onClick={usage.refresh}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-50"
            >
              <span
                className={cn(
                  'inline-flex',
                  busy && 'animate-spinner motion-reduce:animate-none',
                )}
              >
                <RefreshCw size={14} aria-hidden />
              </span>
            </button>
          </Tip>
        )}
      </div>

      {showBalance &&
        (result === null ? (
          <p className="mt-2 text-13 text-[var(--text-secondary)]">
            {t('providerAccountUsage.updating')}
          </p>
        ) : result.status === 'unavailable' ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="flex min-w-0 items-center gap-2 text-13 text-[var(--text-secondary)]">
              <AlertTriangle size={14} className="shrink-0 text-[var(--error-fg)]" aria-hidden />
              <span>{t(errorKey(result.error))}</span>
            </p>
            {/* no-credentials 下重试必然失败：错误文案已指引补密钥，不给死按钮。 */}
            {result.error !== 'no-credentials' && (
              <button
                type="button"
                onClick={usage.refresh}
                className="rounded-full border border-[var(--border-default)] px-3 py-1 text-12 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
              >
                {t('providerAccountUsage.retry')}
              </button>
            )}
          </div>
        ) : result.status === 'ready' ? (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-[var(--text-tertiary)]">
              <span>
                {t('providerAccountUsage.updatedAt', {
                  time: new Intl.DateTimeFormat(locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(result.snapshot.fetchedAt),
                })}
              </span>
              {result.stale && (
                <span
                  data-testid="provider-account-usage-stale"
                  className="inline-flex items-center gap-1 text-[var(--warning-fg)]"
                >
                  <AlertTriangle size={12} aria-hidden />
                  {t('providerAccountUsage.stale')}
                </span>
              )}
              {result.error && (
                <span className="basis-full text-[var(--text-secondary)]">
                  {t(errorKey(result.error))}
                </span>
              )}
            </div>
            <BalanceBody result={result} locale={locale} />
            <button
              type="button"
              onClick={() => void window.electronAPI.openExternal('https://platform.deepseek.com/usage')}
              className="mt-3 inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            >
              {t('providerAccountUsage.openDashboard')}
              <ExternalLink size={12} aria-hidden />
            </button>
          </>
        ) : null)}

      {zhipuUsageLink && (
        <button
          type="button"
          onClick={() => void window.electronAPI.openExternal(ZHIPU_CODING_PLAN_USAGE_URL)}
          className={cn(
            'inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
            showBalance && 'mt-3',
          )}
        >
          {t('providerAccountUsage.zhipuCodingPlan.usage')}
          <ExternalLink size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
