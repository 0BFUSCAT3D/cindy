import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { confirmAgentLocationForPick } from '@/session/sessionAgentSwitchConfirmation';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));

// Run the production callbacks without mounting native controls or remote services.
const source = ts.createSourceFile('session.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
let intentGate = '';
let remoteCatalogGate = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const name = node.name.getText(source);
    if (name === 'orcaModelSelectionUsesIntent') intentGate = node.initializer.getText(source);
    if (name === 'orcaRemoteAgentDeviceId') remoteCatalogGate = node.initializer.getText(source);
    if (ts.isCallExpression(node.initializer) && ['useCallback', 'useMemo'].includes(node.initializer.expression.getText(source))) {
      callbacks.set(name, node.initializer.arguments[0].getText(source));
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

function setup(orcaRole: 'lead' | 'worker' | null, supported = true, agentDeviceId: string | null = null) {
  const selection = { model: 'new-model', providerId: 'provider', effort: 'high', fastMode: true };
  const write = vi.fn(async (_intent: unknown) => true);
  const setModel = vi.fn(async () => true);
  const runControlAction = vi.fn(async (action: () => Promise<unknown>) => action());
  const bindings = {
    currentSession: { orcaRole, agentDeviceId, agentKind: 'codex', model: 'old-model', effort: 'low', fastMode: false },
    currentAgentDeviceId: agentDeviceId,
    remoteAgentCatalogs: ['current', 'other'].map(deviceId => ({ deviceId, providers: [] })),
    sessionAgentSwitchSupported: supported, sessionAgentKind: 'codex', modelSheetAgentKind: 'codex',
    canUseRemoteSessionControls: true, canConfigureSessionModel: true, controlBusy: false,
    sessionId: 's1', deviceId: 'host', deviceIdRef: { current: 'host' },
    agentLocationMovable: false, controlledComputerName: 'Host', remoteAgentDeviceName: vi.fn(),
    agentSwitchIntent: { targetAgentKind: 'codex', ...selection },
    modelSheetSelection: selection, modelSheetCapabilities: { supportsModelWindowSwitchGuard: true },
    sessionMirrorAccessors: {}, composerDeviceProviders: { providers: [] },
    resolveRowSelection: () => selection, reconcileRuntimeDraftWithCapabilities: () => selection,
    resolveAgentCapability: () => ({ supportsFastMode: true, contextWindow: 200000 }),
    normalizeMobileAgentCapabilities: () => ({ hasFastMode: true, supportsModelWindowSwitchGuard: true }),
    maker: { getCapabilities: vi.fn(), setEffort: vi.fn(), setFastMode: vi.fn() },
    confirmAgentLocationForPick, intentChangesAgentLocation: () => false,
    writeSessionAgentSwitchIntent: write, setComposerModel: setModel, runControlAction,
    setModelSheetOpen: vi.fn(), setModelSheetAgentKind: vi.fn(),
  };
  const names = ['selectComposerModelRow', 'selectUnifiedComposerModel', 'selectComposerFlatModel',
    'changeComposerSelectedEffort', 'changeComposerSelectedFastMode'];
  const compiled = ts.transpileModule(`const orcaModelSelectionUsesIntent = ${intentGate};
    const orcaRemoteAgentDeviceId = ${remoteCatalogGate};
    return {${names.map(name => `${name}: ${callbacks.get(name)}`).join(',')},
      catalogs: (${callbacks.get('modelSheetRemoteCatalogs')})()};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handlers = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return { handlers, write, setModel, runControlAction, bindings, selection };
}

const picks = [
  ['selectComposerModelRow', { model: { id: 'new-model', contextWindow: 200000 } }, 'provider'],
  ['selectUnifiedComposerModel', { agent: 'codex', modelId: 'new-model', providerId: 'provider', effort: 'high', fast: true }, 'provider'],
  ['selectComposerFlatModel', { id: 'new-model', contextWindow: 200000 }, null],
] as const;

describe('Orca model-only selection', () => {
  it.each(['lead', 'worker'] as const)('keeps only the current remote catalog and selects in place for %s', async role => {
    const h = setup(role, true, 'current');
    expect(h.handlers.catalogs.map((item: { deviceId: string }) => item.deviceId)).toEqual(['current']);
    expect(await h.handlers.selectUnifiedComposerModel(picks[1][1], { deviceId: 'current' })).toBe(true);
    expect(h.write).toHaveBeenCalledWith({ targetAgentKind: 'codex', model: 'new-model',
      providerId: 'provider', effort: 'high', fastMode: true });
    for (const deviceId of [null, 'other']) {
      expect(await h.handlers.selectUnifiedComposerModel(picks[1][1], { deviceId })).toBe(false);
    }
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.bindings.currentSession.agentDeviceId).toBe('current');
  });

  it.each(['lead', 'worker'] as const)('stages all three model pickers for %s without patching the current runtime', async role => {
    for (const [name, input, providerId] of picks) {
      const h = setup(role);
      await h.handlers[name](input);
      await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
      expect(h.write).toHaveBeenCalledWith({ targetAgentKind: 'codex', model: 'new-model',
        providerId, effort: 'high', fastMode: true });
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.runControlAction).not.toHaveBeenCalled();
      expect(h.bindings.currentSession.model).toBe('old-model');
    }
  });

  it.each([['lead', false], [null, true]] as const)('preserves legacy model routing for role=%s supported=%s', async (role, supported) => {
    for (const [name, input] of picks) {
      const h = setup(role, supported);
      await h.handlers[name](input);
      await vi.waitFor(() => expect(h.setModel).toHaveBeenCalledTimes(1));
      expect(h.write).not.toHaveBeenCalled();
    }
  });

  it('does not fall back to setModel when the switch intent is rejected', async () => {
    const h = setup('worker');
    h.write.mockResolvedValue(false);
    expect(await h.handlers.selectUnifiedComposerModel(picks[1][1])).toBe(false);
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.runControlAction).not.toHaveBeenCalled();
  });

  it.each(['lead', 'worker'] as const)('updates effort and Fast on the pending model for %s', role => {
    const h = setup(role);
    h.handlers.changeComposerSelectedEffort('medium');
    h.handlers.changeComposerSelectedFastMode(false);
    expect(h.write).toHaveBeenNthCalledWith(1, { ...h.bindings.agentSwitchIntent, effort: 'medium' });
    expect(h.write).toHaveBeenNthCalledWith(2, { ...h.bindings.agentSwitchIntent, fastMode: false });
    expect(h.bindings.maker.setEffort).not.toHaveBeenCalled();
    expect(h.bindings.maker.setFastMode).not.toHaveBeenCalled();
  });
});
