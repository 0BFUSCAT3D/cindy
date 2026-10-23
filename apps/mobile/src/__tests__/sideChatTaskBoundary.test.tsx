// @vitest-environment jsdom
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatTaskBoundary } from '../session/SideChatTaskBoundary';

const state = vi.hoisted(() => ({
  focused: true,
  back: vi.fn(),
  canGoBack: true,
  replace: vi.fn(),
  dismissKeyboard: vi.fn(),
  listeners: new Set<(deviceId: string, sessionId: string) => void>(),
  route: { deviceId: 'host', sessionId: 'child' },
}));
vi.mock('react-native', () => ({
  Keyboard: { dismiss: state.dismissKeyboard },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({
  back: state.back, canGoBack: () => state.canGoBack, replace: state.replace,
}) }));
vi.mock('expo-router/react-navigation', () => ({ useIsFocused: () => state.focused }));
vi.mock('../session/remoteSessionStore', () => ({
  remoteSessionStore: {
    onSessionRemoved: (listener: (deviceId: string, sessionId: string) => void) => {
      state.listeners.add(listener);
      return () => { state.listeners.delete(listener); };
    },
  },
}));

// Execute the actual route wrapper (without loading the native editor tree).
// Boundary-only tests cannot catch a task key added by its caller.
const source = ts.createSourceFile('session.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'SessionScreen');
if (!page?.body) throw new Error('SessionScreen not found');
const compiledRoute = ts.transpileModule(`function SessionScreen() ${page.body.getText(source)}`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const SessionRoute = new Function('bindings', `
  const { React, useLocalSearchParams, readRouteParam, remoteSessionStore,
    useRemoteSessionDetail, SideChatTaskBoundary, CindyMakeSessionGate, SessionScreenContent } = bindings;
  ${compiledRoute}
  return SessionScreen;
`)({
  React, SideChatTaskBoundary,
  useLocalSearchParams: () => state.route,
  readRouteParam: (value: string) => value,
  remoteSessionStore: { getSessionDeviceId: () => 'host' },
  useRemoteSessionDetail: () => ({ source: 'local' }),
  CindyMakeSessionGate: ({ children }: { children: React.ReactNode }) => children,
  SessionScreenContent: () => <textarea aria-label="Message" />,
}) as React.ComponentType;

// Unit, black-box regression 2026-10-20: a deleted follow-up kept its editor.
// Picker/count tests do not mount this route boundary. Minimal input: an own
// removal signal, with the route focused or hidden. Full pages must unmount the
// editor and return without waiting for the retired sheet's onClosed callback.
describe('side chat task lifecycle', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = (enabled = true, sessionId = 'child', deviceId = 'host') => act(() => root.render(
    <SideChatTaskBoundary deviceId={deviceId} sessionId={sessionId} enabled={enabled}>
      <textarea aria-label="Message" />
    </SideChatTaskBoundary>,
  ));
  const remove = (deviceId = 'host', sessionId = 'child') => act(() => {
    state.listeners.forEach(listener => listener(deviceId, sessionId));
  });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    state.focused = true;
    state.back.mockClear();
    state.canGoBack = true;
    state.replace.mockClear();
    state.dismissKeyboard.mockClear();
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(state.listeners.size).toBe(0);
  });

  it('unmounts only its own deleted task and returns immediately once', () => {
    render();
    remove('other-host');
    remove('host', 'other-child');
    expect(host.querySelector('textarea')).not.toBeNull();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.dismissKeyboard).toHaveBeenCalled();
    expect(state.back).toHaveBeenCalledTimes(1);
    // Removal also clears task metadata; losing source must not revive content.
    render(false);
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('does not pop a different screen when the removed route is unfocused', () => {
    render();
    state.focused = false;
    render();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    state.focused = true;
    render();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary task removal handling unchanged', () => {
    render(false);
    remove();
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(state.back).not.toHaveBeenCalled();
  });

  it('returns to Home when the removed task has no navigation history', () => {
    state.canGoBack = false;
    render();
    remove();
    expect(state.back).not.toHaveBeenCalled();
    expect(state.replace).toHaveBeenCalledExactlyOnceWith('/');
  });

  // Unit regression 2026-10-24: task-keyed deletion protection remounted the
  // whole page and sidebar on every switch. Existing tests only used one task.
  // The boundary must retain live children yet isolate removal across scopes.
  it('keeps the mounted page when switching ordinary tasks and computers', () => {
    const renderRoute = (sessionId: string, deviceId = 'host') => {
      state.route = { deviceId, sessionId };
      act(() => root.render(<SessionRoute />));
    };
    renderRoute('child');
    const editor = host.querySelector('textarea')!;
    renderRoute('next');
    expect(host.querySelector('textarea')).toBe(editor);
    renderRoute('next', 'other-host');
    expect(host.querySelector('textarea')).toBe(editor);
    expect(state.back).not.toHaveBeenCalled();
  });

  it.each([
    ['next', 'host'],
    ['child', 'other-host'],
  ])('does not carry a hidden deletion into %s on %s', (sessionId, deviceId) => {
    state.focused = false;
    render();
    remove();
    expect(host.querySelector('textarea')).toBeNull();
    state.focused = true;
    render(true, sessionId, deviceId);
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    remove(deviceId, sessionId);
    expect(host.querySelector('textarea')).toBeNull();
    expect(state.back).toHaveBeenCalledTimes(1);
  });

  it('returns once per removed task while ignoring a retired subscription callback', () => {
    render();
    const lateRemoval = [...state.listeners][0]!;
    remove();
    expect(state.back).toHaveBeenCalledTimes(1);
    render(true, 'next');
    const editor = host.querySelector('textarea');
    expect(editor).not.toBeNull();
    act(() => lateRemoval('host', 'child'));
    expect(host.querySelector('textarea')).toBe(editor);
    remove('host', 'next');
    remove('host', 'next');
    expect(state.back).toHaveBeenCalledTimes(2);
    expect(host.querySelector('textarea')).toBeNull();
  });
});
