// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  controllers: [] as Array<{ open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  intersections: new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => undefined }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
vi.mock('@cindy/maker-shared/mcp-app-controller', () => ({
  mcpAppFailureKey: () => 'mcpApps.loadFailed',
  McpAppController: class {
    open = vi.fn(async () => ({ viewId: `view-${state.controllers.length}`, prefersBorder: true }));
    close = vi.fn(async () => {});
    context = vi.fn(async () => {});
    prepareNativeClose = vi.fn();
    constructor() { state.controllers.push(this); }
  },
}));
import { McpAppCard } from '../McpAppCard';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); state.controllers = []; state.intersections.clear(); });
it('does not open offscreen history and releases each visible View before scrolling onward', async () => {
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
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect(state.controllers.every((controller) => controller.close.mock.calls.length === 1)).toBe(true);
});
