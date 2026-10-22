import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  resolveRemoteText,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  type RemoteActionDescriptor,
  type RemoteResource,
  type RemoteText,
  type RemoteActionInvokeResponse,
} from '@cindy/device-link';
import {
  AGENT_ADAPTER_COLLECTION as collectionId,
  AGENT_ADAPTER_KIND as kind,
  agentAdapterCopy as copy,
} from '@cindy/maker-shared/agent-adapters';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/input';

export function AgentAdaptersPage() {
  const { dataOwnerGeneration } = useAuth();
  return <AgentAdaptersContent key={dataOwnerGeneration} />;
}
function AgentAdaptersContent() {
  const { i18n } = useTranslation();
  const label = useCallback(
    (text: RemoteText) => resolveRemoteText(text, i18n.language),
    [i18n.language],
  );
  const [params, setParams] = useSearchParams();
  const deviceId = params.get('device') ?? '',
    resourceId = params.get('run') ?? 'catalog';
  const [devices, setDevices] = useState<{ value: string; label: string; disabled?: boolean }[]>(
    [],
  );
  const [snapshot, setResource] = useState<RemoteResource | null>(null);
  const [loadedBinding, setLoadedBinding] = useState('');
  const [settings, setSettings] = useState<{ enabled: boolean; customized: boolean } | null>(null);
  const [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const lock = useRef(false),
    mounted = useRef(true);
  const binding = deviceId + ':' + resourceId;
  const resource = loadedBinding === binding ? snapshot : null;
  const current = useRef(binding);
  current.current = binding;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const client = { protocolVersion: 1, primitives: ['text', 'form'], locale: i18n.language };
  const select = (id: string, device = deviceId) =>
    setParams({ ...(device ? { device } : {}), ...(id !== 'catalog' ? { run: id } : {}) });
  useEffect(() => {
    let disposed = false;
    const update = () => {
      void window.electronAPI.deviceLink
        .listDevices()
        .then(({ devices }) => {
          if (!disposed)
            setDevices(
              devices
                .filter((d) => !d.isSelf && ['darwin', 'win32', 'linux'].includes(d.platform ?? ''))
                .map((d) => ({
                  value: d.deviceId,
                  label: d.name,
                  disabled: !d.online || !d.remoteControlEnabled || !d.controlEnabled,
                })),
            );
        })
        .catch(() => {});
    };
    update();
    const off = window.electronAPI.deviceLink.onPresenceChanged(update);
    return () => {
      disposed = true;
      off();
    };
  }, []);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      inFlight = false,
      delay = 2000,
      failedSince = 0;
    const read = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      try {
        if (deviceId) await window.electronAPI.deviceLink.openLink(deviceId);
        if (disposed) return;
        const request = {
          client: { protocolVersion: 1, primitives: ['text', 'form'], locale: i18n.language },
          ref: { collectionId, kind, id: resourceId },
        };
        const result = deviceId
          ? ((await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [
              request,
            ])) as RemoteResource)
          : await window.electronAPI.agentAdapters.get(request);
        if (disposed) return;
        if (
          result.ref?.collectionId !== collectionId ||
          result.ref.kind !== kind ||
          result.ref.id !== resourceId
        )
          throw new Error('Invalid resource');
        setResource(result);
        setLoadedBinding(binding);
        if (!deviceId) {
          const state = await window.electronAPI.agentAdapters.settings();
          if (!disposed) setSettings(state);
        }
        if (!disposed) setFailed(false);
        failedSince = 0;
        delay = resourceId === 'catalog' ? 10_000 : 2000;
      } catch {
        if (!disposed) setFailed(true);
        failedSince ||= Date.now();
        delay = Math.min(delay * 2, 10_000);
      } finally {
        inFlight = false;
        if (!disposed && (!failedSince || Date.now() - failedSince < 120_000))
          timer = setTimeout(() => {
            void read();
          }, delay);
      }
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void read();
      }
    };
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [binding, deviceId, resourceId, refresh, i18n.language]);
  const operation = async (fn: () => Promise<void>) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
      return true;
    } catch {
      if (mounted.current && current.current === binding) setFailed(true);
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const invoke = async (actionId: string, input: Record<string, unknown>) =>
    operation(async () => {
      const request = {
        client,
        collectionId,
        resourceRef: { collectionId, kind, id: resourceId },
        actionId,
        input,
      };
      const response = deviceId
        ? ((await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [
            request,
          ])) as RemoteActionInvokeResponse)
        : await window.electronAPI.agentAdapters.invoke(request);
      if (!mounted.current || current.current !== binding) return;
      const effect = response.effects.find((effect) => effect.kind === 'navigate');
      if (
        effect?.kind === 'navigate' &&
        effect.target.kind === 'resource' &&
        effect.target.ref.collectionId === collectionId &&
        effect.target.ref.kind === kind
      )
        select(effect.target.ref.id);
      setRefresh((n) => n + 1);
    });
  const options = [{ value: 'local', label: label(copy.local) }, ...devices];
  if (deviceId && !devices.some((d) => d.value === deviceId))
    options.push({ value: deviceId, label: deviceId });
  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] text-[var(--text-primary)]">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-20 font-medium">{label(copy.title)}</h1>
          <div className="flex flex-wrap gap-2">
            <Select
              label={label(copy.local)}
              value={deviceId || 'local'}
              options={options}
              onValueChange={(value) => select('catalog', value === 'local' ? '' : value)}
            />
            <Button variant="secondary" onClick={() => setRefresh((n) => n + 1)}>
              {label(copy.refresh)}
            </Button>
          </div>
        </div>
        {resourceId !== 'catalog' && (
          <Button className="self-start" variant="secondary" onClick={() => select('catalog')}>
            {label(copy.back)}
          </Button>
        )}
        {!deviceId && settings && loadedBinding === binding && resourceId === 'catalog' && (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                void operation(async () => {
                  await window.electronAPI.agentAdapters.configure(!settings.enabled);
                  setRefresh((n) => n + 1);
                });
              }}
            >
              {label(settings.enabled ? copy.disable : copy.enable)}
            </Button>
            {settings.customized && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void operation(async () => {
                    await window.electronAPI.agentAdapters.configure(null);
                    setRefresh((n) => n + 1);
                  });
                }}
              >
                {label(copy.reset)}
              </Button>
            )}
            {settings.enabled && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void operation(async () => {
                    await window.electronAPI.agentAdapters.pickDirectory();
                    setRefresh((n) => n + 1);
                  });
                }}
              >
                {label(copy.chooseDirectory)}
              </Button>
            )}
          </div>
        )}
        {failed && (
          <p role="alert" className="text-13 text-[var(--text-secondary)]">
            {label(copy.error)}
          </p>
        )}
        {resource && (
          <>
            {resourceId !== 'catalog' && (
              <div>
                <h2 className="text-16 font-medium">{label(resource.display.title)}</h2>
                <p className="text-13 text-[var(--text-secondary)]">
                  {resource.display.subtitle && label(resource.display.subtitle)} ·{' '}
                  {resource.display.status && label(resource.display.status.label)}
                </p>
              </div>
            )}
            {resource.blocks?.map((block) => (
              <p
                key={block.id}
                className="whitespace-pre-wrap break-words text-14 leading-relaxed [overflow-wrap:anywhere]"
              >
                {block.fallbackMarkdown}
              </p>
            ))}
            <div className="flex flex-col gap-4">
              {resource.actions?.map((action) => (
                <AgentActionForm
                  key={binding + ':' + action.id}
                  action={action}
                  label={label}
                  disabled={busy || failed}
                  invoke={(input) => invoke(action.id, input)}
                />
              ))}
            </div>
            {resource.links
              .filter((link) => link.rel === 'item')
              .map(
                (link) =>
                  link.target.kind === 'resource' && (
                    <Button
                      key={link.target.ref.id}
                      variant="secondary"
                      className="h-auto min-h-9 justify-start whitespace-normal py-2 text-left"
                      onClick={() => {
                        if (link.target.kind === 'resource') select(link.target.ref.id);
                      }}
                    >
                      {link.label ? label(link.label) : link.target.ref.id}
                    </Button>
                  ),
              )}
          </>
        )}
      </div>
    </div>
  );
}

export function AgentActionForm({
  action,
  label,
  disabled,
  invoke,
}: {
  action: RemoteActionDescriptor;
  label: (text: RemoteText) => string;
  disabled: boolean;
  invoke: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const receipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const locked = useRef(false);
  const fields = action.fields ?? [];
  const ready = fields.every(
    (field) =>
      !field.required ||
      (values[field.id]?.trim() &&
        (field.kind !== 'select' || field.options?.some((o) => o.value === values[field.id]))),
  );
  return (
    <form
      className="flex flex-col items-start gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked.current || !ready || disabled || action.disabled) return;
        const fingerprint = JSON.stringify(values);
        if (receipt.current?.fingerprint !== fingerprint)
          receipt.current = { fingerprint, id: crypto.randomUUID() };
        locked.current = true;
        void invoke({ ...values, requestId: receipt.current.id })
          .then((ok) => {
            if (ok) {
              receipt.current = null;
              setValues({});
            }
          })
          .finally(() => {
            locked.current = false;
          });
      }}
    >
      {fields.map((field) => (
        <label key={field.id} className="flex w-full flex-col gap-2 text-13">
          <span>{label(field.label)}</span>
          {field.kind === 'select' ? (
            <Select
              label={label(field.label)}
              value={values[field.id] ?? ''}
              options={(field.options ?? []).map((option) => ({
                value: option.value,
                label: label(option.label),
              }))}
              disabled={disabled || action.disabled}
              onValueChange={(value) =>
                setValues((previous) => ({ ...previous, [field.id]: value }))
              }
            />
          ) : (
            <Textarea
              aria-label={label(field.label)}
              rows={3}
              maxLength={32_000}
              value={values[field.id] ?? ''}
              disabled={disabled || action.disabled}
              onChange={(value) => setValues((previous) => ({ ...previous, [field.id]: value }))}
            />
          )}
        </label>
      ))}
      <Button
        type="submit"
        variant={fields.length ? 'primary' : 'secondary'}
        disabled={disabled || action.disabled || !ready}
      >
        {label(action.label)}
      </Button>
    </form>
  );
}
