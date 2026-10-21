import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { extractIpcError } from '@/utils/ipcError';
import type { MyPluginDetailView, MyPluginView, PluginContributionsApi } from '../../../shared/pluginContributions';

const copy = 'settings.ghosts.contribution';

/** Plugin-level author preference. Only a server-confirmed author can write it. */
export function PluginAnonymityControl({
  ownerKey, pluginId, settings, reader, loading = false, unavailable = false,
  onBeforeChange, onCommitted, onUpdated, disabled = false,
}: {
  ownerKey: string;
  pluginId: string;
  settings: MyPluginView['authorSettings'];
  reader: Pick<PluginContributionsApi, 'setAnonymity'>;
  loading?: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  onBeforeChange?: () => void;
  /** Owner-fenced cache invalidation also runs if navigation unmounted this control. */
  onCommitted?: (detail: MyPluginDetailView, appliesToCurrentControl: boolean) => void;
  onUpdated?: (detail: MyPluginDetailView) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const scope = JSON.stringify([ownerKey, pluginId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  const pending = useRef<symbol | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; key: string } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    mounted.current = true;
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  useEffect(() => {
    pending.current = null;
    setBusyScope(null);
    setFailure(null);
  }, [scope]);
  const change = async (anonymous: boolean) => {
    if (disabled || !settings?.canEdit || !navigator.onLine || pending.current) return;
    const operation = Symbol();
    pending.current = operation;
    setBusyScope(scope);
    setFailure(null);
    onBeforeChange?.();
    try {
      const result = await reader.setAnonymity(pluginId, anonymous);
      onCommitted?.(result, mounted.current && currentScope.current === scope && pending.current === operation);
      if (!mounted.current || currentScope.current !== scope || pending.current !== operation) return;
      onUpdated?.(result);
    } catch (error) {
      if (!mounted.current || currentScope.current !== scope || pending.current !== operation) return;
      const code = extractIpcError(error)?.code;
      setFailure({ scope, key: !navigator.onLine ? `${copy}.offline`
        : code === 'PERMISSION_DENIED' ? `${copy}.anonymousAuthorOnly`
        : code === 'OWNER_CHANGED' ? `${copy}.accountChanged` : `${copy}.anonymousUpdateFailed` });
    } finally {
      if (mounted.current && currentScope.current === scope && pending.current === operation) {
        pending.current = null;
        setBusyScope(null);
      }
    }
  };
  if (!settings && !loading && !unavailable) return null;
  const busy = busyScope === scope;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-12 font-normal leading-5 text-[var(--text-tertiary)]">
      <label htmlFor={settings ? id : undefined} title={t(`${copy}.anonymousHint`)}>
        {t(`${copy}.anonymous`)}
      </label>
      {settings ? (
        <Switch id={id} checked={settings.anonymous} disabled={disabled || !settings.canEdit || busy || !online}
          aria-label={t(`${copy}.anonymous`)} aria-busy={busy} aria-describedby={`${id}-hint${!settings.canEdit ? ` ${id}-readonly` : ''}`}
          onCheckedChange={value => void change(value)} />
      ) : (
        <span role="status">{t(`${copy}.${loading ? 'loading' : 'anonymousUnavailable'}`)}</span>
      )}
      <span id={`${id}-hint`} className="sr-only">
        {t(`${copy}.anonymousHint`)}
      </span>
      {settings && !settings.canEdit ? <span id={`${id}-readonly`}>{t(`${copy}.anonymousAuthorOnly`)}</span> : null}
      {settings && !online ? <span role="status">{t(`${copy}.offline`)}</span> : null}
      {failure?.scope === scope ? <span role="alert" className="basis-full text-[var(--text-secondary)]">{t(failure.key)}</span> : null}
    </span>
  );
}
