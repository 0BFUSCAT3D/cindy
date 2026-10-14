import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { getRandomBytes } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTheme, textStyles, fontWeight, radius, spacing } from '@/theme';
import {
  MCP_APPS_INVOKE,
  mcpAppSandboxDocument,
  mcpAppNativeResource,
  mcpAppFrameUrlAllowed,
  type McpAppDocument,
} from '@cindy/maker-shared/mcp-apps';
import {
  McpAppController,
  mcpAppFailureKey,
  type AppRpc,
} from '@cindy/maker-shared/mcp-app-controller';

export function McpAppCard({
  deviceId,
  sessionId,
  clientId,
  title,
  active = true,
}: {
  deviceId?: string;
  sessionId: string;
  clientId: string;
  title: string;
  active?: boolean;
}) {
  const { invoke } = useDeviceLink();
  const { colors, mode } = useTheme();
  const { t, i18n } = useTranslation();
  const webview = useRef<WebView>(null);
  const controller = useRef<McpAppController | undefined>(undefined);
  const [document, setDocument] = useState<McpAppDocument>();
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(320);
  const [error, setError] = useState<ReturnType<typeof mcpAppFailureKey>>();
  const [loading, setLoading] = useState(true);
  const bridgeKey = useMemo(
    () => Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    [deviceId, sessionId, clientId, attempt, active],
  );
  const webSource = useMemo(
    () =>
      document
        ? {
            html: mcpAppSandboxDocument(bridgeKey),
            baseUrl: `https://${document.viewId}.cindy-app.invalid/`,
          }
        : undefined,
    [document?.viewId, bridgeKey],
  );
  const context = useMemo(
    () => ({
      platform: 'mobile',
      theme: mode,
      locale: i18n.resolvedLanguage ?? i18n.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceCapabilities: { touch: true, hover: false },
      containerDimensions: { maxHeight: 1_200 },
      styles: {
        variables: {
          '--color-background-primary': colors.surface,
          '--color-background-secondary': colors.surfaceElevated,
          '--color-text-primary': colors.textPrimary,
          '--color-text-secondary': colors.textSecondary,
          '--color-text-tertiary': colors.textTertiary,
          '--color-border-primary': colors.border,
          '--font-sans': 'system-ui, sans-serif',
        },
      },
    }),
    [mode, colors, i18n.resolvedLanguage, i18n.language],
  );
  const contextRef = useRef(context);
  contextRef.current = context;
  const post = (message: AppRpc) => {
    const serialized = JSON.stringify(JSON.stringify(message)).replace(/</g, '\\u003c');
    webview.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:JSON.parse(${serialized}),source:window}));true;`,
    );
  };

  useEffect(() => {
    let disposed = false;
    if (!active) {
      setDocument(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    if (!deviceId) {
      setError('mcpApps.loadFailed');
      setLoading(false);
      return;
    }
    const view = new McpAppController(
      (id, input) => invoke(deviceId, MCP_APPS_INVOKE, [id, input]),
      sessionId,
      clientId,
      (message) => {
        if (!disposed) post(message);
      },
      (message) => {
        if (disposed) return;
        if (message.method === 'ui/notifications/initialized') setLoading(false);
        if (
          message.method === 'ui/notifications/size-changed' &&
          typeof message.params?.height === 'number' &&
          Number.isFinite(message.params.height)
        ) {
          setHeight(Math.max(80, Math.min(1_200, Math.ceil(message.params.height))));
        }
      },
      (error) => {
        if (!disposed) {
          setError(mcpAppFailureKey(error));
          setLoading(false);
          setDocument(undefined);
        }
      },
      async (url) => {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error('MCP_APP_INVALID_LINK');
        await Linking.openURL(parsed.href);
      },
    );
    controller.current = view;
    setLoading(true);
    setError(undefined);
    setDocument(undefined);
    void view
      .open(contextRef.current)
      .then((document) => {
        if (!document || disposed) return;
        document.html = mcpAppNativeResource(document.html, document.csp);
        setDocument(document);
      })
      .catch((error) => {
        if (!disposed) {
          setError(mcpAppFailureKey(error));
          setLoading(false);
        }
        void view.close().catch(() => {});
      });
    return () => {
      view.prepareNativeClose();
      disposed = true;
      if (controller.current === view) controller.current = undefined;
      void view.close().catch(() => {});
    };
  }, [invoke, deviceId, sessionId, clientId, attempt, active]);
  useEffect(() => {
    void controller.current?.context(context).catch(() => {});
  }, [context]);

  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title} · MCP App</Text>
        {active && loading && <ActivityIndicator size="small" color={colors.textSecondary} />}
        {error && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAttempt((value) => value + 1)}
            style={styles.retry}
          >
            <Text style={[styles.action, { color: colors.textPrimary }]}>{t('mcpApps.retry')}</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={[styles.error, { color: colors.textSecondary }]}>{t(error)}</Text>}
      {active && document && webSource ? (
        <WebView
          ref={webview}
          style={{ height, backgroundColor: colors.surface }}
          source={webSource}
          // Route every navigation through the gate below; a whitelist miss
          // otherwise bypasses it and asks the OS to open an external application.
          originWhitelist={['*']}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          incognito
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows
          allowsInlineMediaPlayback={false}
          mediaPlaybackRequiresUserAction
          onShouldStartLoadWithRequest={(request) => {
            if (request.url === 'about:blank' || request.url === webSource.baseUrl) return true;
            // Android omits isTopFrame. The trusted proxy never navigates, and
            // its opaque-origin App iframe has only allow-scripts: neither the
            // App nor its descendants can navigate the top document or open a
            // popup. Remaining requests can use the declared frame domains;
            // retain iOS's explicit top-frame rejection as an additional guard.
            return (
              request.isTopFrame !== true &&
              mcpAppFrameUrlAllowed(request.url, document.policy?.frameDomains)
            );
          }}
          onMessage={(event) => {
            try {
              const envelope = JSON.parse(event.nativeEvent.data) as {
                key?: string;
                message: AppRpc;
              };
              if (envelope.key !== bridgeKey) return;
              const message = envelope.message;
              if (message.method === 'ui/notifications/sandbox-proxy-ready')
                controller.current?.sandboxReady();
              else controller.current?.receive(message);
            } catch {
              setError('mcpApps.loadFailed');
            }
          }}
          onError={() => {
            setError('mcpApps.loadFailed');
            setLoading(false);
            setDocument(undefined);
            void controller.current?.close().catch(() => {});
          }}
          onContentProcessDidTerminate={() => {
            setError('mcpApps.loadFailed');
            setLoading(false);
            setDocument(undefined);
            void controller.current?.close().catch(() => {});
          }}
          onRenderProcessGone={() => {
            setError('mcpApps.loadFailed');
            setLoading(false);
            setDocument(undefined);
            void controller.current?.close().catch(() => {});
          }}
        />
      ) : !error ? (
        // Keep list geometry stable while the native View is released or loading.
        <View style={{ height }} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container,
    overflow: 'hidden',
    marginVertical: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  title: { ...textStyles.subtitle, fontWeight: fontWeight.medium, flex: 1 },
  action: { ...textStyles.body, fontWeight: fontWeight.medium },
  error: { ...textStyles.footnote, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  retry: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
