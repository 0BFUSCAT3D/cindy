import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import type { PluginTargetPickerPush } from '../../shared/pluginTargets';

/** The host owns the list and selection; a plugin cannot impersonate this dialog. */
export function PluginTargetPickerHost() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<
    (PluginTargetPickerPush & { ownerStamp: DataOwnerPushStamp }) | null
  >(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const off = window.electronAPI.ghosts.onTargetPicker((payload, ownerStamp) => {
      if (!isDataOwnerPushStampCurrent(ownerStamp)) return;
      setQuery('');
      setSelected(null);
      setRequest({ ...payload, ownerStamp });
    });
    const dismiss = window.electronAPI.ghosts.onTargetPickerDismiss((payload) => {
      setRequest((current) => (current?.requestId === payload.requestId ? null : current));
    });
    const auth = window.electronAPI.onAuthStateChange((state) => {
      setRequest((current) =>
        current &&
        state.dataOwnerId === current.ownerStamp.dataOwnerId &&
        state.ownerGeneration === current.ownerStamp.ownerGeneration
          ? current
          : null,
      );
    });
    return () => {
      off();
      dismiss();
      auth();
    };
  }, []);
  if (!request) return null;
  const finish = (id: string | null) => {
    // Hide before notifying main: subsequent desktop capture must not contain the picker.
    setRequest(null);
    if (!isDataOwnerPushStampCurrent(request.ownerStamp)) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void window.electronAPI.ghosts.resolveTargetPicker(request.requestId, id).catch(() => {});
      }),
    );
  };
  const items = request.candidates.filter((item) =>
    `${item.label} ${item.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <ConfirmDialog
      open
      presentation="standard"
      cancelFirst
      maxWidth={520}
      title={t(`pluginTargetPicker.${request.kind}`)}
      description={t(
        request.persistent
          ? 'pluginTargetPicker.bindDescription'
          : 'pluginTargetPicker.onceDescription',
        { name: request.pluginName },
      )}
      confirmText={t(request.persistent ? 'pluginTargetPicker.bind' : 'pluginTargetPicker.choose')}
      cancelText={t('pluginTargetPicker.cancel')}
      confirmDisabled={!selected}
      onConfirm={() => finish(selected)}
      onCancel={() => finish(null)}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
      content={
        <div className="flex min-w-0 flex-col gap-2">
          <Input
            autoFocus
            size="md"
            value={query}
            onChange={setQuery}
            placeholder={t('pluginTargetPicker.search')}
            aria-label={t('pluginTargetPicker.search')}
          />
          <div
            role="group"
            aria-label={t(`pluginTargetPicker.${request.kind}`)}
            className="flex flex-col gap-1"
          >
            {items.map((item) => (
              <button
                key={item.id}
                aria-pressed={selected === item.id}
                onClick={() => setSelected(item.id)}
                className={`min-w-0 rounded-lg border px-3 py-2 text-left ${selected === item.id ? 'border-[var(--text-secondary)] bg-[var(--surface-hover)]' : 'border-transparent hover:bg-[var(--surface-hover)]'}`}
              >
                <span className="block truncate text-13 font-medium text-[var(--text-primary)]">
                  {item.label}
                </span>
                {item.detail && (
                  <span className="block truncate text-12 text-[var(--text-tertiary)]">
                    {item.detail}
                  </span>
                )}
              </button>
            ))}
            {!items.length && (
              <p className="py-6 text-center text-13 text-[var(--text-tertiary)]">
                {t('pluginTargetPicker.empty')}
              </p>
            )}
          </div>
        </div>
      }
    />
  );
}
