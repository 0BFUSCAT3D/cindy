import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Info, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import type { PluginUsageSummary } from '../../../shared/pluginUsage';

export function PluginUsageCard({
  ghostId,
  onOpenTask,
  confirmClear,
}: {
  ghostId: string;
  onOpenTask?: (sessionId: string) => void;
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
      className="mt-6 max-w-[760px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4"
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2
            id={titleId}
            className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]"
          >
            {t('settings.ghosts.usage.title')}
          </h2>
          <Tip text={t('settings.ghosts.usage.explanation')}>
            <button
              type="button"
              aria-label={t('settings.ghosts.usage.explanationLabel')}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <Info size={14} />
            </button>
          </Tip>
        </div>
        <div className="flex items-center gap-1">
          <Tip text={t('settings.ghosts.usage.refresh')}>
            <button
              type="button"
              aria-label={t('settings.ghosts.usage.refresh')}
              disabled={state === 'loading' || clearing}
              onClick={() => void refresh()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
            >
              <RefreshCw size={14} />
            </button>
          </Tip>
          {summary && confirmClear ? (
            <Button
              variant="secondary"
              tone="quiet"
              size="sm"
              disabled={clearing}
              onClick={() => void clear()}
            >
              {t('settings.ghosts.usage.clear')}
            </Button>
          ) : null}
        </div>
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
            <RefreshCw size={14} />
            {t('settings.ghosts.usage.retry')}
          </Button>
        </div>
      ) : summary ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <dt className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                {t('settings.ghosts.usage.lastUsed')}
              </dt>
              <dd className="mt-1 text-14 leading-[1.571] text-[var(--text-primary)]">
                {summary.lastUsedAt === null
                  ? t('settings.ghosts.usage.never')
                  : time(summary.lastUsedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                {t('settings.ghosts.usage.last7Days')}
              </dt>
              <dd className="mt-1 text-14 leading-[1.571] text-[var(--text-primary)]">
                {summary.callsLast7Days.toLocaleString(i18n.language)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-[var(--border-default)] pt-3">
            <h3 className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('settings.ghosts.usage.tasks')}
            </h3>
            {summary.recentTasks.length === 0 ? (
              <p className="mt-2 text-13 leading-5 text-[var(--text-secondary)]">
                {t('settings.ghosts.usage.noTasks')}
              </p>
            ) : (
              <ul className="mt-1 space-y-1">
                {summary.recentTasks.map((task) => (
                  <li key={task.sessionId}>
                    <button
                      type="button"
                      disabled={!onOpenTask}
                      onClick={() => onOpenTask?.(task.sessionId)}
                      className="flex min-h-9 w-full items-center gap-3 rounded-full px-2 text-left hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <span className="min-w-0 flex-1 truncate text-13 leading-5 text-[var(--text-primary)]">
                        {task.title || t('settings.ghosts.usage.untitled')}
                      </span>
                      <span className="shrink-0 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                        {time(task.lastUsedAt)}
                      </span>
                      <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">
            {t('settings.ghosts.usage.localSince', {
              device: summary.deviceName,
              time: time(summary.recordingStartedAt),
            })}
          </p>
        </>
      ) : null}
    </section>
  );
}
