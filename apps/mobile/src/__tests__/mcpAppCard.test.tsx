// @vitest-environment jsdom
import { act, createElement, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { Script } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  props: {} as Record<string, any>,
  inject: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  ActivityIndicator: () => null,
  Pressable: () => null,
  Linking: { openURL: vi.fn() },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock('react-native-webview', () => ({
  WebView: ({ ref, ...props }: any) => {
    state.props = props;
    useImperativeHandle(ref, () => ({ injectJavaScript: state.inject }));
    return createElement('div', { 'data-testid': 'mcp-webview' });
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(1),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: { children: React.ReactNode }) => createElement('span', null, children),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ invoke: state.invoke }),
}));
vi.mock('@/theme', () => {
  const colors = {
    surface: 'white',
    surfaceElevated: 'white',
    textPrimary: 'black',
    textSecondary: 'gray',
    textTertiary: 'gray',
    border: 'gray',
  };
  return {
    useTheme: () => ({ colors, mode: 'light' }),
    textStyles: {},
    fontWeight: {},
    radius: {},
    spacing: {},
  };
});
import { McpAppCard } from '../session/McpAppCard';
const doc = {
  viewId: 'view',
  html: '<script>window.app=true</script>',
  csp: "default-src 'none'",
  prefersBorder: true,
  policy: { frameDomains: ['https://frame.example.org'] },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.invoke.mockReset();
  state.inject.mockReset();
  state.props = {};
  state.invoke.mockImplementation(async (_device, _channel, [, input]) =>
    input.op === 'open' ? { ...doc } : input.op === 'poll' ? new Promise(() => {}) : {},
  );
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it('keeps declared iframe navigation in the WebView and safely injects App HTML', async () => {
  await act(async () =>
    root.render(<McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" />),
  );
  expect(state.props.originWhitelist).toEqual(['*']);
  const allow = state.props.onShouldStartLoadWithRequest;
  expect(allow({ isTopFrame: false, url: 'https://frame.example.org/embed' })).toBe(true);
  expect(allow({ isTopFrame: false, url: 'https://other.example.org/embed' })).toBe(false);
  expect(allow({ isTopFrame: true, url: 'https://frame.example.org/embed' })).toBe(false);
  expect(allow({ isTopFrame: true, url: 'https://view.cindy-app.invalid/' })).toBe(true);
  expect(allow({ isTopFrame: false, url: 'javascript:alert(1)' })).toBe(false);
  // Android supplies no frame identity, including for about:srcdoc and nested frames.
  expect(allow({ url: 'about:srcdoc' })).toBe(true);
  expect(allow({ url: 'https://view.cindy-app.invalid/' })).toBe(true);
  expect(allow({ url: 'https://frame.example.org/embed' })).toBe(true);
  expect(allow({ url: 'https://other.example.org/embed' })).toBe(false);
  expect(allow({ url: 'https://frame.example.org.evil.test/embed' })).toBe(false);
  expect(allow({ url: 'file:///private' })).toBe(false);
  expect(allow({ url: 'javascript:alert(1)' })).toBe(false);
  expect(
    allow({
      isTopFrame: true,
      url: 'https://view.cindy-app.invalid/elsewhere',
    }),
  ).toBe(false);
  state.props.onMessage({
    nativeEvent: {
      data: JSON.stringify({
        key: '01'.repeat(24),
        message: {
          jsonrpc: '2.0',
          method: 'ui/notifications/sandbox-proxy-ready',
        },
      }),
    },
  });
  const script = state.inject.mock.calls[0][0];
  expect(script).not.toContain('<');
  const dispatchEvent = vi.fn();
  new Script(script).runInNewContext({
    window: { dispatchEvent },
    MessageEvent: class {
      data: unknown;
      constructor(_type: string, init: { data: unknown }) {
        this.data = init.data;
      }
    },
  });
  expect(dispatchEvent.mock.calls[0][0].data.params.html).toContain(doc.html);

  // Exercise the actual native proxy: its sandbox must prevent every App and
  // descendant from navigating the trusted top document, even with user activation.
  const shell = document.implementation.createHTMLDocument();
  const listeners = new Map<string, (event: unknown) => void>();
  const proxy = {
    ReactNativeWebView: { postMessage: vi.fn() },
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
  };
  const proxyDocument = new DOMParser().parseFromString(state.props.source.html, 'text/html');
  const proxyScript = proxyDocument.querySelector('script')!.textContent!;
  new Script(proxyScript).runInNewContext({ document: shell, window: proxy });
  listeners.get('message')!({
    source: proxy,
    data: dispatchEvent.mock.calls[0][0].data,
  });
  const appFrame = shell.querySelector('iframe')!;
  expect(appFrame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(appFrame.srcdoc).toContain('http-equiv="Content-Security-Policy"');
  expect(appFrame.srcdoc).toContain(doc.html);
});

it('releases offscreen Views, stops polling and reopens only the newly visible card', async () => {
  const polls = new Map<string, (events: unknown[]) => void>();
  state.invoke.mockImplementation(async (_device, _channel, [, input]) => {
    if (input.op === 'open') return { ...doc, viewId: input.clientId };
    if (input.op === 'poll') return new Promise((resolve) => polls.set(input.viewId, resolve));
    return {};
  });
  const renderCards = (visible: number) =>
    root.render(
      <>
        {Array.from({ length: 6 }, (_, index) => (
          <McpAppCard
            key={index}
            deviceId="device"
            sessionId="task"
            clientId={`card-${index}`}
            title="App"
            active={index === visible}
          />
        ))}
      </>,
    );
  const inputs = (op: string) =>
    state.invoke.mock.calls.map(([, , [, input]]) => input).filter((input) => input.op === op);
  await act(async () => renderCards(-1));
  expect(state.invoke).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(0);

  await act(async () => renderCards(0));
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0']);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(1);
  await act(async () => renderCards(5));
  expect(inputs('teardown')).toEqual([expect.objectContaining({ viewId: 'card-0' })]);
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0', 'card-5']);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(1);

  // A poll from the old View cannot inject into the replacement or schedule another poll.
  state.inject.mockClear();
  await act(async () =>
    polls.get('card-0')!([{ seq: 1, message: { jsonrpc: '2.0', method: 'old' } }]),
  );
  expect(state.inject).not.toHaveBeenCalled();
  expect(inputs('poll').filter((input) => input.viewId === 'card-0')).toHaveLength(1);
  await act(async () => renderCards(0));
  expect(inputs('teardown').map((input) => input.viewId)).toEqual(['card-0', 'card-5']);
  expect(inputs('open').map((input) => input.clientId)).toEqual(['card-0', 'card-5', 'card-0']);
});

it('cancels an offscreen pending open and disposes its late View without mounting it', async () => {
  let finishOpen!: (document: typeof doc) => void;
  state.invoke.mockImplementation(async (_device, _channel, [, input]) =>
    input.op === 'open'
      ? new Promise((resolve) => {
          finishOpen = resolve;
        })
      : {},
  );
  const renderCard = (active: boolean) =>
    root.render(
      <McpAppCard deviceId="device" sessionId="task" clientId="card" title="App" active={active} />,
    );
  await act(async () => renderCard(true));
  const opening = state.invoke.mock.calls[0][2][1];
  await act(async () => renderCard(false));
  expect(state.invoke).toHaveBeenCalledWith('device', 'maker:mcp-apps:v1', [
    'task',
    { op: 'cancel-open', openId: opening.openId },
  ]);
  await act(async () => finishOpen({ ...doc }));
  expect(state.invoke).toHaveBeenCalledWith('device', 'maker:mcp-apps:v1', [
    'task',
    { op: 'teardown', viewId: 'view' },
  ]);
  expect(container.querySelectorAll('[data-testid="mcp-webview"]')).toHaveLength(0);
  expect(state.invoke.mock.calls.map(([, , [, input]]) => input.op)).toEqual([
    'open',
    'cancel-open',
    'teardown',
  ]);
});
