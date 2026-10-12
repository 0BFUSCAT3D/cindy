// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate } from '@/session/CindyMakeSessionGate';

const state = vi.hoisted(() => ({ sessions: [] as Array<{ id: string; source: string }>, listeners: new Set<() => void>() }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessions: () => state.sessions,
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
} }));
vi.mock('expo-router', () => ({ Redirect: ({ href }: { href: string }) => createElement('span', {}, `redirect:${href}`) }));

let root: Root;
let container: HTMLDivElement;
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let originalActEnvironment: boolean | undefined;
beforeEach(() => {
  originalActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  state.sessions = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove(); state.listeners.clear();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

describe('mobile Cindy Make links', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('redirects %s to Home before mounting the task screen', (source) => {
    state.sessions = [{ id: 'old-task', source }];
    const Content = vi.fn(() => createElement('span', {}, 'Composer'));
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><Content /></CindyMakeSessionGate>));
    expect(container.textContent).toBe('redirect:/');
    expect(Content).not.toHaveBeenCalled();
  });

  it('redirects when a cold link receives Make metadata and keeps ordinary tasks visible', () => {
    act(() => root.render(<CindyMakeSessionGate sessionId="old-task"><span>Composer</span></CindyMakeSessionGate>));
    expect(container.textContent).toBe('Composer');
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'cindy-make' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('redirect:/');
    act(() => {
      state.sessions = [{ id: 'old-task', source: 'desktop' }];
      for (const listener of state.listeners) listener();
    });
    expect(container.textContent).toBe('Composer');
  });
});
