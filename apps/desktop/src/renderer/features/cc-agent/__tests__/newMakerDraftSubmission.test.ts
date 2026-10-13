import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider, getModel, type PiReasoningEffort, type ProviderView } from '@cindy/model-providers';
import { resolveSessionExecutionSelection } from '../../../../main/maker-ipc/sessionExecutionSelection';
import * as draftEffort from '../newMakerDraftModelPrefs';
import { create as createSessionViaIpc } from '@/lib/sessionService';
import type { Effort } from '@/lib/userPreferences.types';

vi.mock('@/lib/makerTransport', () => ({ makerApiFor: vi.fn() }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: vi.fn() }));

// Execute the production route's complete send callback, without mounting the unrelated
// home panels. Only external services and React closure state are fixtures; neither the
// submit body nor Main's admission rules are copied or stubbed. This also catches effort
// being dropped for create but leaking back into the first-message handoff.
const source = ts.createSourceFile('NewMakerDraftRoute.tsx', readFileSync(
  resolve(__dirname, '../NewMakerDraftRoute.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSend'
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('NewMakerDraftRoute.handleSend callback missing');
const executable = ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const modelId = 'qwen3:8b';
const providerId = 'custom:cindy-local-ollama';
function provider(id = providerId, efforts: PiReasoningEffort[] = []): ProviderView {
  const configured = buildUserProvider({
    id: id.replace(/^custom:/, ''), name: id, auth: { method: 'none' },
    runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1', wireProtocol: 'openai-chat',
      models: [{ id: modelId, name: modelId, reasoning: efforts.length > 0,
        ...(efforts.length ? { reasoningEfforts: efforts } : {}) }],
    } },
  });
  // Tests may use another connection ID; the route must honor that exact ID.
  return { ...configured, id, connected: true } as ProviderView;
}

async function submit(options: {
  effort?: Effort;
  providers?: ProviderView[];
  backendProviders?: ProviderView[];
  providerId?: string;
  agentKind?: 'pi' | 'codex';
  remoteHostId?: string;
  agentDeviceId?: string;
} = {}) {
  const providers = options.providers ?? [provider()];
  const backend = options.backendProviders ?? providers;
  const agentKind = options.agentKind ?? 'pi';
  const selectedProviderId = options.providerId ?? providerId;
  const errors: unknown[] = [];
  const availableProviders = (agent: 'pi' | 'codex' | 'claude-code') =>
    backend.filter(p => p.connected).map(p => ({ id: p.id, name: p.name,
      models: (p.models[agent] ?? []).map(m => m.id),
      effortMetaByModel: Object.fromEntries((p.models[agent] ?? []).map(m => [m.id, m])),
    }));
  const routing = {
    availability: {
      pi: availableProviders('pi'), codex: availableProviders('codex'),
      'claude-code': availableProviders('claude-code'),
    },
    resolveDefaultProviderIdForModel: () => selectedProviderId,
  };
  const admit = (selection: Parameters<typeof resolveSessionExecutionSelection>[0]['selection']) =>
    resolveSessionExecutionSelection({ selection, availableAgents: [agentKind],
      availableModels: backend.flatMap(p => p.models[agentKind] ?? []),
      providerRouting: routing, hasCindyAiApiKey: false });
  const ipcCreate = vi.fn(async (body) => ({
    ...body, ...admit(body), id: 'created', workingDir: '/isolated/dialogue',
  }));
  // Real renderer adapter forwards to the simulated IPC transport, whose receiving
  // side runs Main's production admission. No real database or user profile is opened.
  vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { create: ipcCreate } } } });
  const createSession = vi.fn(async (body) => {
    try { return await createSessionViaIpc(body); }
    catch (error) { errors.push(error); return null; }
  });
  const sendMessage = vi.fn(async (_id, _text, model, effort) => {
    admit({ model, effort, agentKind, providerId: selectedProviderId });
    return true;
  });
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const noop = () => {};
  const environment = {
    ...draftEffort, getModel,
    localProviders: providers, localProvidersLoading: false, providers,
    capabilityAgentKind: agentKind, persistedAgentKind: agentKind,
    effectiveSourceId: selectedProviderId,
    sendInFlightRef: { current: false }, effectiveCollab: { enabled: false },
    collabPolicy: { enabled: false }, collabPolicyEligible: false,
    usesDeviceCatalog: false, isDeviceLinkDraft: false, isRemoteProjectDraft: !!options.remoteHostId,
    effectiveRemoteHostId: options.remoteHostId, effectiveAgentDeviceId: options.agentDeviceId,
    effectiveWorkingDir: options.remoteHostId ? '/remote/project' : null,
    effectiveExtraDirs: [], effectiveWritableDirs: [], effectiveFastMode: false, effectivePlanMode: false,
    effectiveDeviceLinkDeviceId: undefined, catalogDeviceId: undefined,
    matchNavigationCommandName: () => null,
    wtRef: { current: { enabled: false, confirmedIneligible: true } },
    wtPreferenceSavingRef: { current: false }, wtPreferenceAuthorityUnknownRef: { current: false },
    wtBranchPreferenceSavingRef: { current: false },
    getDataOwnerGeneration: () => ({ dataOwnerId: 'fixture' }), dataOwnerId: 'fixture',
    isDataOwnerGenerationCurrent: () => true,
    markSendInFlight: (value: boolean) => { if (!value) done(); },
    t: (key: string) => key, authVendor: agentKind,
    vendorAuthGate: { checkAndConfirm: async () => ({ proceed: true }) },
    localDraftSessionIdRef: { current: 'draft-id' }, optimisticFirstMessageTitle: () => null,
    createSession, toastCreateSessionFailed: noop, carryDraftFavoriteAnchorToSession: noop,
    makerChatStore: { setSessionRuntime: noop, sendMessage }, sessionsStore: { patchLocal: noop },
    markSessionStarting: noop, clearSessionStarting: noop,
    rehomeDraftAttachments: async () => [], getComposerDraft: () => null,
    NEW_MAKER_DRAFT_KEY: 'fixture', rewriteBrowserCommentsFromRehomedFiles: () => [],
    leadingSlashInvocation: () => null,
    rewritePiSkillMessageForSend: async ({ message }: { message: string }) => message,
    clearComposerDraftAndNotify: noop, attachmentState: { clearFiles: noop },
    resetDraftWorkspaceAfterSend: noop, navigate: vi.fn(), setWtCreating: noop,
    dispatchDeferredUiAssignment: async () => {},
    isRemotePrecreatedWorktreeOwnerChangedError: () => false,
    isRemotePrecreatedWorktreeCleanupPendingError: () => false,
    getRemoteWorkingDirErrorMessage: () => null,
    emitAutoTitlePreviewCleared: noop, restoreRemoteOptimisticDraft: noop,
    plainTextToTiptapDoc: noop, excludeCommentScreenshots: () => [],
    log: { warn: (...args: unknown[]) => errors.push(args), error: (...args: unknown[]) => errors.push(args) },
    toast: { error: noop, warning: noop },
  };
  const handleSend = runInNewContext(executable, environment);
  try {
    await handleSend('hello', modelId, options.effort ?? 'medium', 'default', [], [], { providerId: selectedProviderId });
    await finished;
    return { createSession, ipcCreate, sendMessage, errors, environment };
  } finally { vi.unstubAllGlobals(); }
}

describe('homepage submission to Main admission and first-message handoff', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)('omits remembered %s for a known no-effort Pi model', async effort => {
    const result = await submit({ effort });
    expect(result.errors).toEqual([]);
    expect(result.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: modelId, providerId, agentKind: 'pi', effort: undefined,
    }));
    expect(result.ipcCreate.mock.calls[0][0].effort).toBeUndefined();
    expect(result.sendMessage).toHaveBeenCalledWith('created', 'hello', modelId, '',
      'default', '/isolated/dialogue', [], [], expect.any(Object));
  });
  it('preserves a supported effort for the exact provider, even when another has no efforts', async () => {
    const result = await submit({ providers: [provider(), provider('other', ['high'])], providerId: 'other', effort: 'high' });
    expect(result.errors).toEqual([]);
    expect(result.createSession.mock.calls[0][0].effort).toBe('high');
    expect(result.sendMessage.mock.calls[0][3]).toBe('high');
  });
  it('still rejects an explicitly invalid effort on a model with supported levels', async () => {
    const result = await submit({ providers: [provider(providerId, ['high'])] });
    expect(String(result.errors[0])).toContain('not supported');
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
  it('does not use a different provider when the submitted identity is absent', async () => {
    const result = await submit({ providerId: 'absent' });
    expect(result.createSession.mock.calls[0][0].effort).toBe('medium');
    expect(result.errors).toHaveLength(1);
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
  it('preserves unknown effort capability', async () => {
    const p = provider(); p.models.pi![0].effortsUnknown = true;
    const result = await submit({ providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('does not treat an unloaded catalog as an explicit empty effort table', async () => {
    const result = await submit({ providers: [], backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('does not use local Pi metadata for SSH execution', async () => {
    const result = await submit({ remoteHostId: 'fixture-host', backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('does not use local metadata for an Agent running on another computer', async () => {
    const result = await submit({ agentDeviceId: 'other-computer', backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('selects metadata by engine as well as provider and model', async () => {
    const p = provider();
    p.models.codex = [{ ...p.models.pi![0], efforts: ['medium'], defaultEffort: 'medium' }];
    const result = await submit({ agentKind: 'codex', providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('retains the draft preference when switching away and back to a supported model', async () => {
    const memory = Object.freeze({ effort: 'high' as const });
    const noEffort = await submit({ effort: draftEffort.resolveNewMakerDraftEffort({
      currentEffort: memory.effort, efforts: [], defaultEffort: null,
    }) });
    expect(noEffort.errors).toEqual([]);
    expect(noEffort.sendMessage.mock.calls[0][3]).toBe('');
    const supported = await submit({ providers: [provider(providerId, ['low', 'high'])],
      effort: draftEffort.resolveNewMakerDraftEffort({ currentEffort: memory.effort,
        efforts: ['low', 'high'], defaultEffort: 'low' }),
    });
    expect(supported.errors).toEqual([]);
    expect(supported.sendMessage.mock.calls[0][3]).toBe('high');
    expect(memory.effort).toBe('high');
  });
  it('does not bypass disconnected-provider admission', async () => {
    const p = provider(); p.connected = false;
    const result = await submit({ providers: [p] });
    expect(result.errors).toHaveLength(1);
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
});
