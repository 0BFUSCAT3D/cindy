import { ArrowDownToLine, PackageCheck, Tally5 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

/** Only server-authorized aggregates; custom public flags never grant shared statistics. */
export function PluginSharedUsage({ detail }: { detail: PluginMarketItem }) {
  const { t, i18n } = useTranslation();
  if (detail.sourceType !== 'server' || detail.scope === 'personal') return null;
  const stats = detail.usageStatistics;
  const downloads = detail.downloadStatistics;
  if (!stats && !downloads) return null;
  const explanation = stats
    ? t('settings.ghosts.usage.sharedExplanation', {
        scope: t(`settings.ghosts.usage.sharedScope.${detail.scope}`),
      }) + ` ${t('settings.ghosts.usage.asOf', { time: stats.asOf })}`
    : '';
  return (
    <>
      <span aria-hidden="true">·</span>
      {downloads ? (
        <Tip text={t('settings.ghosts.usage.downloadExplanation')}>
          <button
            type="button"
            className="inline-flex min-h-7 items-center gap-1 rounded-full focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <ArrowDownToLine size={12} aria-hidden="true" />
            <span>
              {t('settings.ghosts.usage.downloads')}{' '}
              {BigInt(downloads.requestCount).toLocaleString(i18n.language)}
            </span>
          </button>
        </Tip>
      ) : null}
      {stats ? (
        <>
          <Tip text={explanation}>
            <button
              type="button"
              className="inline-flex min-h-7 items-center gap-1 rounded-full focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <PackageCheck size={12} aria-hidden="true" />
              <span>
                {t('settings.ghosts.usage.installs')} {stats.installationCount}
              </span>
            </button>
          </Tip>
          <Tip text={explanation}>
            <button
              type="button"
              className="inline-flex min-h-7 items-center gap-1 rounded-full focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <Tally5 size={12} aria-hidden="true" />
              <span>
                {t('settings.ghosts.usage.uses')} {stats.usageCount}
              </span>
            </button>
          </Tip>
        </>
      ) : null}
    </>
  );
}
