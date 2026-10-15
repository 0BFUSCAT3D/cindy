// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
const state = vi.hoisted(() => ({
  deviceId: undefined as string | undefined,
  openError: undefined as Error | undefined,
  controllers: [] as Array<{
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    fail: (error: unknown) => void;
    invoke: (session: string, input: Record<string, unknown>) => Promise<unknown>;
  }>,
  intersections: new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { title: string }) => key === 'mcpApps.cardTitle' ? values?.title : key,
  i18n: { language: 'en' },
}) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => state.deviceId }));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: React.ComponentProps<'button'>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@cindy/maker-shared/mcp-app-controller', () => ({
  mcpAppFailureKey: () => 'mcpApps.loadFailed',
  McpAppController: class {
    open = vi.fn(async () => {
      if (state.openError) throw state.openError;
      return { viewId: `view-${state.controllers.length}`, prefersBorder: true };
    });
    close = vi.fn(async () => {});
    context = vi.fn(async () => {});
    prepareNativeClose = vi.fn();
    constructor(
      readonly invoke: (session: string, input: Record<string, unknown>) => Promise<unknown>,
      _session: string,
      _client: string,
      _post: unknown,
      _message: unknown,
      readonly fail: (error: unknown) => void,
    ) { state.controllers.push(this); }
  },
}));
import { McpAppCard } from '../McpAppCard';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.controllers = [];
  state.intersections.clear();
  state.deviceId = undefined;
  state.openError = undefined;
});
it.each([undefined, 'owner-device'])('releases offscreen history and opens visible owner cards on %s', async (deviceId) => {
  state.deviceId = deviceId;
  const invoke = vi.fn(async () => ({}));
  const generalInvoke = vi.fn();
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke }, deviceLink: { invoke: generalInvoke } });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<>{Array.from({ length: 17 }, (_, i) =>
      <McpAppCard key={i} sessionId="task" clientId={`card-${i}`} title={`App ${i}`} />)}</>));
    expect(state.controllers).toHaveLength(0);
    const callbacks = [...state.intersections.values()];
    for (let i = 0; i < callbacks.length; i++) {
      await act(async () => {
        if (i) callbacks[i - 1]([{ isIntersecting: false }]);
        callbacks[i]([{ isIntersecting: true }]);
      });
      expect(state.controllers).toHaveLength(i + 1);
      expect(state.controllers.filter((controller) => controller.close.mock.calls.length === 0)).toHaveLength(1);
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      await state.controllers[i].invoke('task', { op: 'open', clientId: `card-${i}` });
      expect(invoke).toHaveBeenLastCalledWith('task', deviceId
        ? { op: 'open', clientId: `card-${i}`, deviceId } : { op: 'open', clientId: `card-${i}` });
      expect(generalInvoke).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect(state.controllers.every((controller) => controller.close.mock.calls.length === 1)).toBe(true);
});

it.each(['light', 'dark'])('shows saved text without mounting an interactive guest View in %s mode', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  state.deviceId = sharedTaskHostPeer('shared-task', 'host-device');
  const invoke = vi.fn();
  vi.stubGlobal('electronAPI', { maker: { mcpApps: invoke }, deviceLink: { invoke } });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="card" title="Saved form"
      fallbackText="Saved result <script>window.attack=true</script>" />));
    expect(container.textContent).toContain('Saved form');
    expect(container.textContent).toContain('Saved result <script>window.attack=true</script>');
    expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
    expect(container.textContent).not.toContain('mcpApps.loadFailed');
    expect(container.querySelector('iframe, button, script')).toBeNull();
    expect(state.controllers).toHaveLength(0);
    expect(state.intersections.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => root.render(<McpAppCard sessionId="task" clientId="pending" title="Pending form" />));
    expect(container.textContent).toContain('Pending form');
    expect(container.textContent).toContain('mcpApps.sharedTaskReadOnly');
  } finally {
    await act(async () => root.unmount());
    document.documentElement.classList.remove('dark');
  }
});

it.each(['light', 'dark'])('keeps saved text readable after App failures and retry in %s mode', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) { state.intersections.set(element, this.callback); }
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  state.openError = new Error('MCP_APP_SERVER_CHANGED');
  const saved = 'Saved result\n<script>window.attack=true</script>';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <McpAppCard sessionId="task" clientId="card" title="Saved form" fallbackText={saved} />,
    ));
    const [observed, intersect] = [...state.intersections.entries()][0];
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(container.textContent).toContain(saved);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('mcpApps.loadFailed');
    expect(container.querySelector('iframe, script')).toBeNull();
    // Retry must remain observable even after the empty iframe area collapses.
    expect(observed).toBe(container.querySelector('section'));
    state.openError = undefined;
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).not.toContain(saved);
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(state.controllers).toHaveLength(2);
    await act(async () => state.controllers[1].fail(new Error('offline')));
    expect(container.textContent).toContain(saved);
    expect(container.querySelector('iframe, script')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.classList.remove('dark');
  }
});
