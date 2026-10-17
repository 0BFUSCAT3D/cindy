// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import {
  NEW_SESSION_AGENT_OPTIONS, hostDraftRuntimeFromDefaults, isHostDraftDefaultsReady,
  resolveNewSessionAutoDefault, type NewSessionRuntime,
  isStoredAgentRestorePending, nextStoredAgentRestoreStep, canResolveStoredAgentRuntime, pickAgentDefaultRuntime,
} from '@/session/newSession';
import {
  cacheNewSessionHostDefaults, getNewSessionHostDefaults, rememberNewSessionHostRuntime,
} from '@/session/newSessionHostDefaultsCache';

// Unit regression for #5816: run the page's real defaults hooks, without its
// unrelated native UI. Existing newSession tests cover selection policy but not
// remount/remote-read timing. Minimum failure: reopen while the next RPC is pending.
const source = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
const start = source.indexOf('  const [hostDraftDefaults, setHostDraftDefaults]');
const end = source.indexOf('  // selectedDeviceId 的渲染期镜像', start);
const autoStart = source.indexOf('  useEffect(() => {', source.indexOf('  // 决策逻辑全在纯函数 resolveNewSessionAutoDefault'));
const autoEnd = source.indexOf('\n\n  // 目录就绪后的来源终检', autoStart);
const storedStart = source.lastIndexOf('  useEffect(() => {', source.indexOf('    const storedAgentKind = newSessionPreferences?.agentKind;'));
const storedEnd = source.indexOf('\n\n  // 权限记忆恢复:', storedStart);
if (start < 0 || end < 0) throw new Error('New-session host defaults hooks not found');
const compiled = ts.transpileModule(`function usePageDefaults(bindings) {
  const { useState, useRef, useEffect, useCallback, selectedDeviceId, deviceLinkStatus,
    maker, openLink, outboxOwner, selectedDeviceRef, remoteAgentChoice,
    resolveNewSessionAutoDefault, deviceProviders, modelRows, modelSections,
    isStoredAgentRestorePending, nextStoredAgentRestoreStep, canResolveStoredAgentRuntime, pickAgentDefaultRuntime,
    getMobileAuthOwner, isMobileAuthOwnerCurrent, NEW_SESSION_AGENT_OPTIONS,
    hostDraftRuntimeFromDefaults, isHostDraftDefaultsReady, withTransientRemoteRetry,
    cacheNewSessionHostDefaults, getNewSessionHostDefaults, rememberNewSessionHostRuntime } = bindings;
  const [draft, setDraft] = useState(bindings.draft);
  const userTouchedRuntimeRef = useRef(false);
  const autoDefaultDeviceRef = useRef(null);
  const autoDefaultSnapshotRef = useRef(undefined);
  ${source.slice(start, end)}
  const newSessionPreferencesLoaded = true, newSessionPreferences = bindings.preferences, capabilities = undefined;
  const appliedPermissionMemoryRef = useRef(true);
  const defaultPermissionModeForNewSessionAgent = () => 'default';
  const confirmFullAccessChange = async () => true;
  const settleRuntime = () => {};
  const storedAgentRestoreRef = useRef(null), runtimeActionSeqRef = useRef(0);
  const deviceProvidersRef = useRef(deviceProviders), catalogReadyRef = useRef(false);
  const preferredDefaultDevice = { deviceId: selectedDeviceId };
  const mobileDebugLog = () => {}, flattenProviderSections = () => [];
  const buildMobileModelSections = () => ({ sections: [] }), flatModelsForUnsupportedHost = () => [];
  const isFastRestorable = () => false, targetAgentHasFast = () => false;
  const draftMemory = { getFast: () => false };
  ${source.slice(storedStart, storedEnd)}
  ${source.slice(autoStart, autoEnd)}
  return { settled: hostDefaultsSettled, runtime: hostRuntimeFor('codex'),
    draft, wait: waitHostDraftDefaults, choose: (mark) => {
      userTouchedRuntimeRef.current = true;
      setDraft(bindings.draft);
      requestHostChoiceWrite(mark);
    } };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
interface State {
  settled: boolean;
  runtime: NewSessionRuntime | null;
  draft: { model: string; agentKind: string };
  wait(deviceId: string, agent: string): Promise<void>;
  choose(markModelChoice: boolean): void;
}
const usePageDefaults = new Function(`${compiled}; return usePageDefaults;`)() as
  (bindings: Record<string, unknown>) => State;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { setMobileAuthOwner('defaults-test'); });
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  setMobileAuthOwner(null);
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(deviceId = 'desktop', agentKind = 'codex', failedAgent?: string, storedAgent?: string) {
  if (root) act(() => root!.unmount());
  const read = deferred<unknown>();
  const bindings = {
    useState, useRef, useEffect, useCallback,
    selectedDeviceId: deviceId, deviceLinkStatus: 'online', selectedDeviceRef: { current: deviceId },
    outboxOwner: getMobileAuthOwner(), remoteAgentChoice: null,
    draft: { agentKind, model: 'chosen', providerId: 'provider', effort: 'high', fastMode: false },
    maker: { getNewMakerDefaults: vi.fn((agent?: string) => agent === failedAgent ? Promise.reject(new Error('read failed')) : read.promise), applyNewMakerDraftPref: vi.fn(async () => {}) },
    openLink: vi.fn(async () => {}),
    getMobileAuthOwner, isMobileAuthOwnerCurrent, NEW_SESSION_AGENT_OPTIONS,
    hostDraftRuntimeFromDefaults, isHostDraftDefaultsReady, withTransientRemoteRetry,
    cacheNewSessionHostDefaults, getNewSessionHostDefaults, rememberNewSessionHostRuntime,
    resolveNewSessionAutoDefault, deviceProviders: { ready: false, unsupported: false },
    isStoredAgentRestorePending, nextStoredAgentRestoreStep, canResolveStoredAgentRuntime, pickAgentDefaultRuntime,
    preferences: storedAgent ? { agentKind: storedAgent, permissionModeByAgent: {} } : undefined,
    modelRows: [], modelSections: { connected: [] },
  };
  let state!: State;
  function Harness() { state = usePageDefaults(bindings); return null; }
  root = createRoot(document.createElement('div'));
  const render = () => act(() => root!.render(createElement(Harness)));
  render();
  return { read, bindings, render, get state() { return state; } };
}
const defaults = (model: string) => ({ worktreeEnabled: false, model, providerId: 'provider', effort: 'high' });

it('restores the remembered engine before applying fresh background defaults', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('cached')));
  const page = mount('desktop', 'codex', undefined, 'pi');
  await act(async () => {});
  expect(page.state.draft.agentKind).toBe('pi');
  expect(page.state.draft.model).toBe('cached');
  await act(async () => page.read.resolve(defaults('fresh')));
  expect(page.state.draft.agentKind).toBe('pi');
  expect(page.state.draft.model).toBe('fresh');
});

it('reopens with cached defaults immediately and refreshes the next visit in the background', async () => {
  const first = mount();
  expect(first.state.settled).toBe(false);
  await act(async () => first.read.resolve(defaults('first')));
  expect(first.state.runtime?.model).toBe('first');

  const second = mount();
  expect(second.state.settled).toBe(true);
  expect(second.state.runtime?.model).toBe('first');
  let waited = false;
  await act(async () => { void second.state.wait('desktop', 'codex').then(() => { waited = true; }); });
  expect(waited).toBe(true);
  await act(async () => second.read.resolve(defaults('updated-on-desktop')));
  expect(second.state.draft.model).toBe('updated-on-desktop');
  expect(mount().state.runtime?.model).toBe('updated-on-desktop');
  await act(async () => {});
});

it('keeps a manual model choice across a late refresh and the next new task', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const second = mount();
  act(() => second.state.choose(true));
  await act(async () => second.read.resolve(defaults('old-response')));
  expect(second.state.runtime?.model).toBe('chosen');
  expect(second.state.draft.model).toBe('chosen');
  expect(mount().state.runtime?.model).toBe('chosen');
  await act(async () => {});
});

it('caches successful engines independently and waits for an uncached engine on reopen', async () => {
  const first = mount('desktop', 'codex', 'pi');
  await act(async () => first.read.resolve(defaults('first')));
  expect(getNewSessionHostDefaults('desktop')?.byAgent.codex?.model).toBe('first');
  expect(getNewSessionHostDefaults('desktop')?.byAgent.pi).toBeUndefined();
  expect(mount().state.settled).toBe(true);
  const pi = mount('desktop', 'pi');
  expect(pi.state.settled).toBe(false);
  await act(async () => pi.read.resolve(defaults('pi-choice')));
  expect(pi.state.settled).toBe(true);
});

it('preserves cached defaults on refresh failure, but does not cache a failed first read', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const second = mount();
  await act(async () => second.read.reject(new Error('read failed')));
  expect(second.state.runtime?.model).toBe('first');
  expect(mount().state.runtime?.model).toBe('first');

  const other = mount('other-desktop');
  expect(other.state.settled).toBe(false);
  expect(other.state.runtime).toBeNull();
  await act(async () => other.read.reject(new Error('read failed')));
  expect(other.state.settled).toBe(true);
  expect(mount('other-desktop').state.settled).toBe(false);
});

it('drops cached and in-flight defaults when the account changes', async () => {
  const first = mount();
  await act(async () => first.read.resolve(defaults('first')));
  const pending = mount();
  act(() => pending.state.choose(true));
  act(() => setMobileAuthOwner('different-account'));
  const newAccount = deferred<unknown>();
  pending.bindings.outboxOwner = getMobileAuthOwner();
  pending.bindings.maker.getNewMakerDefaults.mockImplementation(() => newAccount.promise);
  pending.render();
  expect(pending.state.settled).toBe(false);
  expect(pending.state.runtime).toBeNull();
  await act(async () => pending.read.resolve(defaults('old-account')));
  expect(getNewSessionHostDefaults('desktop')).toBeNull();
  await act(async () => newAccount.resolve(defaults('new-account')));
  expect(mount().state.runtime?.model).toBe('new-account');
  await act(async () => {});
});

it('caches a confirmed empty default but retries an unready host without discarding old defaults', async () => {
  vi.useFakeTimers();
  const first = mount();
  await act(async () => first.read.resolve({ worktreeEnabled: false }));
  const second = mount();
  expect(second.state.settled).toBe(true);
  expect(second.state.runtime).toBeNull();
  await act(async () => second.read.resolve({}));
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(second.bindings.maker.getNewMakerDefaults).toHaveBeenCalledTimes(9);
  expect(mount().state.settled).toBe(true);
  await act(async () => {});
});
