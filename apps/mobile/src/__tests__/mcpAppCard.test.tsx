// @vitest-environment jsdom
import { act, createElement, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ props: {} as Record<string, any>, inject: vi.fn(), invoke: vi.fn() }));
vi.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => null, Pressable: () => null, Linking: { openURL: vi.fn() },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock('react-native-webview', () => ({ WebView: ({ ref, ...props }: any) => {
  state.props = props;
  useImperativeHandle(ref, () => ({ injectJavaScript: state.inject }));
  return createElement('div');
} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(1) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: React.ReactNode }) => createElement('span', null, children) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: state.invoke }) }));
vi.mock('@/theme', () => {
  const colors = { surface: 'white', surfaceElevated: 'white', textPrimary: 'black', textSecondary: 'gray', textTertiary: 'gray', border: 'gray' };
  return { useTheme: () => ({ colors, mode: 'light' }), textStyles: {}, fontWeight: {}, radius: {}, spacing: {} };
});
import { McpAppCard } from '../session/McpAppCard';
it('keeps declared iframe navigation in the WebView and safely injects App HTML', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const doc = { viewId: 'view', html: '<script>window.app=true</script>', csp: "default-src 'none'", prefersBorder: true, policy: { frameDomains: ['https://frame.example.org'] } };
  state.invoke.mockImplementation(async (_device, _channel, [, input]) =>
    input.op === 'open' ? { ...doc } : input.op === 'poll' ? new Promise(() => {}) : {});
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />));
    expect(state.props.originWhitelist).toEqual(['*']);
    const allow = state.props.onShouldStartLoadWithRequest;
    expect(allow({ isTopFrame: false, url: 'https://frame.example.org/embed' })).toBe(true);
    expect(allow({ isTopFrame: false, url: 'https://other.example.org/embed' })).toBe(false);
    expect(allow({ isTopFrame: true, url: 'https://frame.example.org/embed' })).toBe(false);
    expect(allow({ isTopFrame: true, url: 'https://view.cindy-app.invalid/' })).toBe(true);
    expect(allow({ isTopFrame: false, url: 'javascript:alert(1)' })).toBe(false);
    state.props.onMessage({ nativeEvent: { data: JSON.stringify({ key: '01'.repeat(24), message: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' } }) } });
    const script = state.inject.mock.calls[0][0];
    expect(script).not.toContain('<');
    const dispatchEvent = vi.fn();
    new Script(script).runInNewContext({ window: { dispatchEvent }, MessageEvent: class {
      data: unknown; constructor(_type: string, init: { data: unknown }) { this.data = init.data; }
    } });
    expect(dispatchEvent.mock.calls[0][0].data.params.html).toContain(doc.html);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
