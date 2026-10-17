// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { forgetRemoteDraftDefaults, getRemoteDraftDefaults, rememberRemoteDraftDefaults } from '../remoteDraftDefaultsCache';
import type { RemoteDraftDefaults } from '../deviceLinkDraftDefaults';

// Unit regression: existing pure default resolvers cannot detect a page remount
// blocking on RPC, or a cache bypassing the worktree write confirmation. Execute
// the production page's hooks without mounting unrelated composer/IPC features.
const source = readFileSync(resolve(process.cwd(), 'src/renderer/features/cc-agent/NewMakerDraftRoute.tsx'), 'utf8');
const start = source.indexOf('  const [remoteDraftState, setRemoteDraftState]');
const end = source.indexOf('  // 运行 Agent 的电脑只提供模型目录', start);
if (start < 0 || end < 0) throw new Error('Remote defaults hooks not found');
const compiled = ts.transpileModule(`function usePageDefaults(bindings) {
  const { useState, useRef, useEffect, isDeviceLinkDraft, effectiveDeviceLinkDeviceId,
    capabilityAgentKind, useDeviceLinkReconnectEpoch, extractIpcError,
    getDataOwnerGeneration, isDataOwnerGenerationCurrent, getRemoteDraftDefaults,
    rememberRemoteDraftDefaults, wtPreferenceTransactionRef, dataOwnerId } = bindings;
  ${source.slice(start, end)}
  return { remoteDraftState, setRemoteDraftRetryEpoch };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
type State = {
  remoteDraftState: { status: string; value: RemoteDraftDefaults | null };
  setRemoteDraftRetryEpoch: (update: (epoch: number) => number) => void;
};
const usePageDefaults = new Function(`${compiled}; return usePageDefaults;`)() as (bindings: unknown) => State;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => setDataOwnerGeneration('cache-test'));
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });
function mount(deviceId = 'host', agent = 'codex') {
  act(() => root?.unmount());
  let resolveRead!: (value: unknown) => void;
  let rejectRead!: (error: unknown) => void;
  const promise = new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
  const invoke = vi.fn(() => promise);
  Object.assign(window, { electronAPI: { deviceLink: { invoke } } });
  const bindings = {
    useState, useRef, useEffect, isDeviceLinkDraft: true, effectiveDeviceLinkDeviceId: deviceId,
    capabilityAgentKind: agent, useDeviceLinkReconnectEpoch: () => 0,
    extractIpcError: (error: unknown) => error,
    getDataOwnerGeneration, isDataOwnerGenerationCurrent, getRemoteDraftDefaults, rememberRemoteDraftDefaults,
    wtPreferenceTransactionRef: { current: null as { deviceId: string; status: string; enabled?: boolean } | null },
    dataOwnerId: getDataOwnerGeneration().dataOwnerId,
  };
  let state!: State;
  function Harness() { state = usePageDefaults(bindings); return null; }
  root = createRoot(document.createElement('div'));
  const render = () => act(() => root!.render(createElement(Harness)));
  render();
  return { bindings, render, invoke, resolveRead, rejectRead, get state() { return state; } };
}
const defaults = (model: string) => ({ model, modelChosenByUser: true, worktreeEnabled: false });

it('reopens immediately with host defaults, refreshes in the background and preserves them on failure', async () => {
  const first = mount();
  expect(first.state.remoteDraftState.status).toBe('loading');
  await act(async () => first.resolveRead(defaults('chosen')));
  const reopened = mount();
  expect(reopened.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('chosen') });
  expect(reopened.invoke).toHaveBeenCalledTimes(1);
  await act(async () => reopened.resolveRead(defaults('new-choice')));
  expect(reopened.state.remoteDraftState.value?.model).toBe('new-choice');
  const failedRefresh = mount();
  await act(async () => failedRefresh.rejectRead(new Error('offline')));
  expect(failedRefresh.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('new-choice') });
  const restartingHost = mount();
  await act(async () => restartingHost.resolveRead({}));
  expect(restartingHost.state.remoteDraftState).toEqual({ status: 'ready', value: defaults('new-choice') });
});

it('isolates device, engine and account, and rejects a late response from the old account', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  expect(mount('other').state.remoteDraftState.status).toBe('loading');
  expect(mount('host', 'pi').state.remoteDraftState.status).toBe('loading');
  const old = mount();
  setDataOwnerGeneration('new-owner');
  await act(async () => old.resolveRead(defaults('old-owner-late')));
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
  expect(mount().state.remoteDraftState.status).toBe('loading');
});

it('does not use cached defaults to acknowledge a pending worktree write', async () => {
  rememberRemoteDraftDefaults('host', 'codex', defaults('chosen'));
  const page = mount();
  page.bindings.wtPreferenceTransactionRef.current = { deviceId: 'host', status: 'reconciling-success' };
  act(() => page.state.setRemoteDraftRetryEpoch(epoch => epoch + 1));
  expect(page.state.remoteDraftState.status).toBe('loading');
  await act(async () => page.rejectRead(new Error('offline')));
  expect(page.state.remoteDraftState.status).toBe('error');
  forgetRemoteDraftDefaults('host');
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
});

it('keeps initial errors retryable and does not remember an uninitialized host snapshot', async () => {
  const failed = mount();
  await act(async () => failed.rejectRead(new Error('offline')));
  expect(failed.state.remoteDraftState.status).toBe('error');
  const empty = mount();
  await act(async () => empty.resolveRead({}));
  expect(getRemoteDraftDefaults('host', 'codex')).toBeUndefined();
  const legacy = mount();
  await act(async () => legacy.rejectRead({ code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }));
  expect(legacy.state.remoteDraftState.status).toBe('ready');
});
