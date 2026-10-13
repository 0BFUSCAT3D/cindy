import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PluginUsageSummary } from '../../../shared/pluginUsage';

export function PluginUsageCard({
  ghostId,
  confirmClear,
}: {
  ghostId: string;
  confirmClear?: () => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [summary, setSummary] = useState<PluginUsageSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [clearing, setClearing] = useState(false);
  const load = useCallback(async () => {
    const next = await window.electronAPI.ghosts.usageSummary(ghostId);
    if (!next) throw new Error('Usage unavailable');
    return next;
  }, [ghostId]);
  useEffect(() => {
    let live = true;
    setSummary(null);
    setState('loading');
    void load()
      .then((value) => {
        if (live) {
          setSummary(value);
          setState('ready');
        }
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, [load]);
  const refresh = async () => {
    setState('loading');
    try {
      setSummary(await load());
      setState('ready');
    } catch {
      setSummary(null);
      setState('failed');
    }
  };
  const clear = async () => {
    if (!summary || clearing || !(await confirmClear?.())) return;
    setClearing(true);
    try {
      await window.electronAPI.ghosts.clearUsage(summary.subjectId);
      await refresh();
    } catch {
      setSummary(null);
      setState('failed');
    } finally {
      setClearing(false);
    }
  };
  const time = (value: number) =>
    new Date(value).toLocaleString(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(new Date(value).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    });
  return (
    <section
      className="mt-6 w-full max-w-[480px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-13 font-medium leading-5 text-[var(--text-secondary)]">
          <Tip text={t('settings.ghosts.usage.explanation')}>
            <button
              type="button"
              aria-label={`${t('settings.ghosts.usage.title')} · ${t('settings.ghosts.usage.explanationLabel')}`}
              className="-ml-2 min-h-7 rounded-full px-2 hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              {t('settings.ghosts.usage.title')}
            </button>
          </Tip>
        </h2>
        <DropdownMenu>
          <Tip text={t('settings.ghosts.usage.more')}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('settings.ghosts.usage.more')}
                className="-mr-1 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={state === 'loading' || clearing}
              onSelect={() => void refresh()}
            >
              {t('settings.ghosts.usage.refresh')}
            </DropdownMenuItem>
            {summary && confirmClear ? (
              <DropdownMenuItem
                disabled={state === 'loading' || clearing}
                onSelect={() => void clear()}
              >
                {t('settings.ghosts.usage.clear')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {state === 'loading' ? (
        <p aria-live="polite" className="mt-3 text-13 leading-5 text-[var(--text-secondary)]">
          {t('settings.ghosts.usage.loading')}
        </p>
      ) : state === 'failed' ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('settings.ghosts.usage.unavailable')}
          </p>
          <Button variant="secondary" tone="quiet" size="sm" onClick={() => void refresh()}>
            {t('settings.ghosts.usage.retry')}
          </Button>
        </div>
      ) : summary ? (
        <dl className="mt-4 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-5">
          <div className="min-w-0">
            <dt className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.ghosts.usage.lastUsed')}
            </dt>
            <dd className="mt-2 text-20 font-medium leading-8 tabular-nums text-[var(--text-primary)]">
              {summary.lastUsedAt === null
                ? t('settings.ghosts.usage.never')
                : time(summary.lastUsedAt)}
            </dd>
          </div>
          <div className="min-w-0 border-l border-[var(--border-default)] pl-5">
            <dt className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.ghosts.usage.last7Days')}
            </dt>
            <dd className="mt-2 break-words text-24 font-medium leading-8 tabular-nums text-[var(--text-primary)]">
              {summary.callsLast7Days.toLocaleString(i18n.language)}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
