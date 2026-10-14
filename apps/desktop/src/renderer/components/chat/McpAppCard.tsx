import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import {
  McpAppController,
  mcpAppFailureKey,
  type AppRpc,
  type AppInvoker,
} from '@cindy/maker-shared/mcp-app-controller';
import { MCP_APPS_INVOKE } from '@cindy/maker-shared/mcp-apps';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

function hostContext(locale: string, element: HTMLElement): Record<string, unknown> {
  const style = getComputedStyle(document.documentElement);
  const variable = (name: string) => style.getPropertyValue(name).trim();
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: 'desktop',
    userAgent: 'Cindy',
    deviceCapabilities: {
      touch: navigator.maxTouchPoints > 0,
      hover: matchMedia('(hover: hover)').matches,
    },
    containerDimensions: { width: Math.round(element.clientWidth), maxHeight: 1_200 },
    styles: {
      variables: {
        '--color-background-primary': variable('--surface'),
        '--color-background-secondary': variable('--surface-elevated'),
        '--color-background-tertiary': variable('--surface-hover'),
        '--color-text-primary': variable('--text-primary'),
        '--color-text-secondary': variable('--text-secondary'),
        '--color-text-tertiary': variable('--text-tertiary'),
        '--color-border-primary': variable('--border-default'),
        '--color-border-secondary': variable('--border-subtle'),
        '--color-text-danger': variable('--error-fg'),
        '--color-text-warning': variable('--warning-fg'),
        '--font-sans': variable('--font-sans') || style.fontFamily,
        '--font-mono': variable('--font-mono'),
        '--border-radius-md': '8px',
      },
    },
  };
}

interface McpAppCardProps {
  sessionId: string;
  clientId: string;
  title: string;
  fallbackText?: string;
}

export function McpAppCard(props: McpAppCardProps) {
  const { t } = useTranslation();
  // Shared-task peers can read history, but must not create an interactive View.
  if (isSharedTaskPeer(getStickySessionDeviceId(props.sessionId))) {
    const title = props.title ? t('mcpApps.cardTitle', { title: props.title }) : t('mcpApps.appName');
    return (
      <section className="my-3 rounded-xl border border-border p-3" aria-label={title}>
        <div className="text-13 text-[var(--text-secondary)]">{title}</div>
        {props.fallbackText && (
          <p className="mt-3 whitespace-pre-wrap break-words text-14 text-[var(--text-primary)]">
            {props.fallbackText}
          </p>
        )}
        <p className="mt-3 text-13 text-[var(--text-secondary)]">{t('mcpApps.sharedTaskReadOnly')}</p>
      </section>
    );
  }
  return <InteractiveMcpAppCard {...props} />;
}

/** Untrusted HTML always sits across an origin boundary, without Cindy's preload. */
function InteractiveMcpAppCard({ sessionId, clientId, title }: McpAppCardProps) {
  const { t, i18n } = useTranslation();
  const appTitle = title || t('mcpApps.appName');
  const root = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<McpAppController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ReturnType<typeof mcpAppFailureKey>>();
  const [loading, setLoading] = useState(true);
  const [height, setHeight] = useState(320);
  const [mode, setMode] = useState('inline');
  const [border, setBorder] = useState(true);
  const [visible, setVisible] = useState(false);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState !== 'hidden');
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element || !visible) return;
    let disposed = false;
    let frame: HTMLIFrameElement | undefined;
    let localViewId: string | undefined;
    const deviceId = getStickySessionDeviceId(sessionId);
    const invoke: AppInvoker = deviceId
      ? (id, input) => window.electronAPI.deviceLink.invoke(deviceId, MCP_APPS_INVOKE, [id, input])
      : (id, input) => window.electronAPI.maker.mcpApps(id, input);
    const post = (message: AppRpc) => frame?.contentWindow?.postMessage(message, '*');
    const fail = (error: unknown) => {
      if (!disposed) {
        setLoading(false);
        setError(mcpAppFailureKey(error));
        frame?.remove();
        setMode('inline');
      }
    };
    const controller = new McpAppController(
      invoke,
      sessionId,
      clientId,
      post,
      (message) => {
        if (disposed) return;
        if (message.method === 'ui/notifications/initialized') setLoading(false);
        if (message.method === 'ui/notifications/size-changed') {
          const value = message.params?.height;
          if (typeof value === 'number' && Number.isFinite(value))
            setHeight(Math.max(80, Math.min(1_200, Math.ceil(value))));
        }
        if (message.method === 'ui/notifications/host-context-changed') {
          const mode = message.params?.displayMode;
          if (mode === 'inline' || mode === 'fullscreen') setMode(mode);
        }
      },
      fail,
      async (url) => {
        if (!localViewId || disposed) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
        await window.electronAPI.maker.mcpApps(sessionId, {
          op: 'open-link',
          viewId: localViewId,
          url,
        });
      },
    );
    controllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    setMode('inline');
    const receive = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data as AppRpc;
      if (message?.method === 'ui/notifications/sandbox-proxy-ready') {
        controller.sandboxReady(`cindy-mcp-app://${localViewId}-view/resource`);
      } else controller.receive(message);
    };
    window.addEventListener('message', receive);
    void controller
      .open(hostContext(localeRef.current, element))
      .then(async (document) => {
        if (!document || disposed) return;
        localViewId = deviceId
          ? ((await window.electronAPI.maker.mcpApps(sessionId, {
              op: 'mount-remote',
              document,
            })) as string)
          : document.viewId;
        if (disposed) {
          if (deviceId)
            void window.electronAPI.maker.mcpApps(sessionId, {
              op: 'unmount-remote',
              viewId: localViewId,
            });
          return;
        }
        setBorder(document.prefersBorder);
        frame = window.document.createElement('iframe');
        frame.title = appTitle;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.setAttribute(
          'allow',
          "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'",
        );
        frame.style.cssText = 'width:100%;height:100%;display:block;border:0';
        frame.src = `cindy-mcp-app://${localViewId}/sandbox`;
        element.appendChild(frame);
      })
      .catch((error) => {
        fail(error);
        void controller.close().catch(() => {});
      });
    const update = () => {
      void controller.context(hostContext(localeRef.current, element)).catch(() => {});
    };
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    const sizeObserver = new ResizeObserver(update);
    sizeObserver.observe(element);
    return () => {
      disposed = true;
      controllerRef.current = undefined;
      // Notify before hiding the frame; close() retains the View until the
      // teardown response arrives or the bounded wait expires.
      controller.prepareNativeClose();
      themeObserver.disconnect();
      sizeObserver.disconnect();
      // Atomic move preserves the Chromium frame during its bounded teardown handshake.
      if (frame) {
        frame.style.cssText =
          'position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none';
        const body = document.body as HTMLElement & {
          moveBefore?: (node: Node, child: Node | null) => void;
        };
        if (body.moveBefore) body.moveBefore(frame, null);
        else controller.prepareNativeClose();
      }
      void controller
        .close()
        .catch(() => {})
        .finally(() => {
          frame?.remove();
          window.removeEventListener('message', receive);
          if (deviceId && localViewId)
            void window.electronAPI.maker
              .mcpApps(sessionId, { op: 'unmount-remote', viewId: localViewId })
              .catch(() => {});
        });
    };
  }, [sessionId, clientId, attempt, appTitle, visible]);

  useEffect(() => {
    if (root.current)
      void controllerRef.current?.context(hostContext(locale, root.current)).catch(() => {});
  }, [locale]);
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const previousFocus = document.activeElement as HTMLElement | null;
    root.current?.parentElement
      ?.querySelector<HTMLButtonElement>('button[data-exit-fullscreen]')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void controllerRef.current?.displayMode('inline').catch(() => {});
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [mode]);
  return (
    <section
      className={
        mode === 'fullscreen'
          ? 'fixed inset-4 z-50 flex flex-col rounded-xl border border-border bg-[var(--surface-elevated)] p-3'
          : `my-3 overflow-hidden rounded-xl ${border ? 'border border-border' : ''}`
      }
      aria-label={appTitle}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 px-3 text-13 text-[var(--text-secondary)]">
        <span>{title ? t('mcpApps.cardTitle', { title }) : appTitle}</span>
        {loading && visible && <Spinner size="sm" />}
        {mode === 'fullscreen' && (
          <Button
            data-exit-fullscreen
            variant="secondary"
            size="sm"
            onClick={() => {
              void controllerRef.current?.displayMode('inline').catch(() => {});
            }}
          >
            {t('mcpApps.exitFullscreen')}
          </Button>
        )}
        {error && (
          <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t('mcpApps.retry')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-3 pb-3 text-13 text-[var(--text-secondary)]">
          {t(error)}
        </p>
      )}
      <div
        ref={root}
        style={{
          height: mode === 'fullscreen' ? undefined : height,
          flex: mode === 'fullscreen' ? 1 : undefined,
        }}
      />
    </section>
  );
}
