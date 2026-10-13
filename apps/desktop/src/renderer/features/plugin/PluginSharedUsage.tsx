import { ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

/** Only server-authorized download counts; custom public flags never grant shared statistics. */
export function PluginSharedUsage({ detail }: { detail: PluginMarketItem }) {
  const { t, i18n } = useTranslation();
  if (detail.sourceType !== 'server' || detail.scope === 'personal') return null;
  const downloads = detail.downloadStatistics;
  if (!downloads) return null;
  return (
    <>
      <span aria-hidden="true">·</span>
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
    </>
  );
}
