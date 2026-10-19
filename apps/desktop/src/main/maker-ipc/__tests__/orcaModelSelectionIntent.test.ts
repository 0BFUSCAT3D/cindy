import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { applyPendingAgentSwitchIfIdle, createPendingAgentSwitchRegistry, type MakerSessionAgentSwitchHandlerDeps, type PendingAgentSwitchIntent } from '../sessionAgentSwitchHandler';
import { parseOrcaRemoteLead } from '../../../shared/orcaRemoteWorker';

// Execute the actual picker admission branches (local and agent-device), with
// everything after admission represented by applyLive. No Electron bootstrap.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const branches: string[] = [];
const confirmationChecks: string[] = [];
let applySelectionAdapter = '';
let piWindowOverride = '';
let directSendAdapter = '';
let archivedAdmission = '';
let terminalGuard = '';
function visit(node: ts.Node) {
  if (ts.isBinaryExpression(node) && node.left.getText(source) === 'pendingAgentSwitchApplyHolder') {
    directSendAdapter = node.right.getText(source);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'canStageArchivedSelection') {
    archivedAdmission = node.initializer!.getText(source);
  }
  if (ts.isIfStatement(node) && node.expression.getText(source) === "runtimeStatus.status !== 'active' && !canStageArchivedSelection") {
    terminalGuard = node.getText(source);
  }
  if (ts.isPropertyAssignment(node)) {
    if (node.name.getText(source) === 'confirmedTargetPressure' && node.initializer.getText(source).includes('runtimeStatus.orcaRole')) {
      confirmationChecks.push(node.initializer.getText(source));
    }
    if (node.name.getText(source) === 'selectSameAgentModel') applySelectionAdapter = node.initializer.getText(source);
  }
  if (ts.isIfStatement(node) && node.expression.getText(source).includes('!internalOptions.applyingUserSelectionOnSend')
    && node.thenStatement.getText(source).includes('pendingUntilSend: true')) {
    branches.push(node.getText(source));
  }
  if (ts.isIfStatement(node) && node.thenStatement.getText(source).includes('targetContextWindow = confirmedContextWindow ?? targetContextWindow')) {
    piWindowOverride = node.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const remoteLead = { leadDeviceId: 'lead-device', leadSessionId: 'lead-session', workerLabel: 'worker' };
const orcaIdentities = [
  { orcaRole: 'lead' },
  { orcaRole: 'worker' },
  { orcaRole: null, orcaRemoteLead: JSON.stringify(remoteLead) },
];

describe('Orca model-only picker intent admission', () => {
  // PR #6403 P1: the composer already restores archived tasks, but Goal's
  // direct-send lease did not. Execute the real lease, send boundary and model
  // admission together; earlier picker tests stop before this boundary (unit).
  const directSendCases = ['archived', 'cross-engine', 'relocation', 'repicked-during-restore', 'config', 'agent', 'restore-failed', 'cancelled'] as const;
  it.each(directSendCases)('handles archived direct-send selection: %s', async mode => {
    const compile = (expression: string, bindings: Record<string, unknown>) => {
      const js = ts.transpileModule(`return ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
    };
    const row = { id: 's1', status: 'archived', agentKind: 'codex', model: 'old', providerId: 'provider',
      sdkSessionId: null, remoteHostId: null, agentDeviceId: null };
    const pending = createPendingAgentSwitchRegistry();
    const crossEngine = mode === 'cross-engine' || mode === 'repicked-during-restore';
    const intent: PendingAgentSwitchIntent = { targetAgentKind: crossEngine ? 'pi' : 'codex', model: 'new', providerId: 'provider',
      ...(mode === 'relocation' ? { targetAgentDeviceId: 'executor-device' } : !crossEngine ? { sameAgentSelection: true } : {}),
      ...(mode === 'config' ? { configStaged: true } : mode === 'agent' ? { runtimeSource: 'agent' } : {}),
    };
    pending.set('s1', intent);
    const applied = vi.fn(() => ({ deferred: false }));
    const throwIpcError = (code: string, message: string) => { throw new Error(`[${code}] ${message}`); };
    const admission = compile(`(internalOptions) => {
      const canStageArchivedSelection = ${archivedAdmission};
      ${terminalGuard}
      return applied();
    }`, { runtimeStatus: row, applied, throwIpcError });
    const selectSameAgentModel = compile(applySelectionAdapter, { throwIpcError,
      applySessionRuntimeSelection: (_id: string, _model: string, _provider: unknown, _axes: unknown, opts: unknown) => admission(opts),
    });
    const release = vi.fn();
    const acquire = vi.fn(async () => release);
    let finishRestore: (() => void) | undefined;
    const restore = vi.fn(async () => {
      if (mode === 'restore-failed') throw new Error('restore failed');
      if (mode === 'repicked-during-restore') await new Promise<void>(resolve => { finishRestore = resolve; });
      row.status = 'active';
    });
    const switchToDb = vi.fn(async (_id: string, patch: object) => {
      expect(row.status).toBe('active');
      Object.assign(row, patch);
    });
    const automatic = mode === 'config' || mode === 'agent';
    const deps = { pendingSwitches: pending, getSessionRow: async () => row,
      getLiveSession: () => ({ isTurnRunning: () => automatic }), selectSameAgentModel,
      closeSession: vi.fn(), listMessagesForHandoff: async () => [], applyAgentSwitchToDb: switchToDb,
      setSessionProvider: vi.fn(), insertBoundaryMessage: async () => 'boundary', setPendingHandoff: vi.fn(),
      bootstrapSwitchedSession: vi.fn(), withCloseSuppressed: (_id: string, fn: () => Promise<unknown>) => fn(),
      log: { info: vi.fn(), warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
    const directSend = compile(directSendAdapter, {
      agentSwitchPending: pending, restoreArchivedSessionForSend: restore,
      acquireSendToSessionLock: acquire, reconcileBotModelRoute: vi.fn(),
      applyPendingAgentSwitchIfIdle, agentSwitchDeps: deps, contextOverflowRolloverHolder: null,
    });
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    if (automatic) {
      const lease = await directSend('s1', controller.signal);
      expect(restore).not.toHaveBeenCalled();
      expect(row.status).toBe('archived');
      expect(pending.get('s1')).toBe(intent);
      expect(applied).not.toHaveBeenCalled();
      expect(switchToDb).not.toHaveBeenCalled();
      lease.release();
    } else if (mode !== 'restore-failed' && mode !== 'cancelled') {
      const sending = directSend('s1', controller.signal);
      // A later picker choice while restore awaits must be the one applied.
      if (mode === 'repicked-during-restore') {
        expect(restore).toHaveBeenCalledOnce();
        pending.set('s1', { ...intent, model: 'latest' });
        finishRestore!();
      }
      const lease = await sending;
      expect(row.status).toBe('active');
      if (mode === 'archived') expect(applied).toHaveBeenCalledOnce();
      else {
        expect(switchToDb).toHaveBeenCalledOnce();
        expect(row.model).toBe(mode === 'repicked-during-restore' ? 'latest' : 'new');
        expect(row.agentKind).toBe(mode === 'relocation' ? 'codex' : 'pi');
        if (mode === 'relocation') expect(row.agentDeviceId).toBe('executor-device');
      }
      expect(pending.get('s1')).toBeUndefined();
      expect(restore.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0]);
      expect(release).not.toHaveBeenCalled();
      lease.release();
      expect(release).toHaveBeenCalledOnce();
    } else {
      await expect(directSend('s1', controller.signal)).rejects.toThrow(mode === 'restore-failed' ? 'restore failed' : /abort/i);
      expect(row.status).toBe('archived');
      expect(applied).not.toHaveBeenCalled();
      expect(switchToDb).not.toHaveBeenCalled();
      expect(pending.get('s1')).toBeDefined();
      if (mode === 'cancelled') expect(restore).not.toHaveBeenCalled();
      else expect(acquire).not.toHaveBeenCalled();
    }
  });

  it.each(['lead', 'worker'] as const)('stages %s model and axes on both execution locations until send', async orcaRole => {
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const onOtherDevice = !branch.includes('!runtimeStatus.remoteHostId');
      const pending = new Map();
      const applyLive = vi.fn(() => ({ deferred: false, superseded: false }));
      const changed = vi.fn();
      const runtimeStatus = { orcaRole, remoteHostId: null, agentDeviceId: onOtherDevice ? 'other' : null,
        agentKind: 'codex', model: 'old', providerId: 'old-provider', effort: 'low', fastMode: false };
      const internalOptions = { source: 'user', applyingUserSelectionOnSend: false };
      const bindings = {
        internalOptions, runtimeStatus, sessionId: 's1', model: 'new',
        targetProviderId: 'provider', effectiveProviderId: 'provider', currentProviderId: 'old-provider',
        agentKind: 'codex', dbToMakerAgentKind: (kind: string) => kind,
        targetEffort: 'high', targetFastMode: true, targetContextWindow: undefined,
        confirmedContextWindow: 200000 as number | undefined,
        atomicSelection: { effort: 'high', fastMode: true },
        assertRuntimeOwnerCurrent: vi.fn(), assertSharedTaskCurrent: { admit: vi.fn() },
        assertAgentDeviceRouteUsable: vi.fn(), supersededByOwnerBoundary: () => false,
        clearPendingCredentialSwitchForSession: vi.fn(), agentSwitchPending: pending,
        agentSwitchDeps: { onPendingSwitchChanged: changed },
        projectPendingAgentSwitchIntent: (intent: unknown) => intent,
        wakeSessionInputAfterCredentialSwitch: vi.fn(),
        isDeviceLinkInvoke: () => true, markRemoteSettingPersistedInsideHandler: vi.fn(), applyLive,
      };
      const compiled = ts.transpileModule(`return async () => { ${branch}; return applyLive(); };`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const run = () => new Function(...Object.keys(bindings), compiled)(...Object.values(bindings))();
      expect(await run()).toMatchObject({ deferred: true, pendingUntilSend: true });
      expect(pending.get('s1')).toMatchObject({ sameAgentSelection: true, targetAgentKind: 'codex',
        model: 'new', providerId: 'provider', effort: 'high', fastMode: true });
      expect(changed).toHaveBeenCalledTimes(1);
      // A deferred choice must not let Device Link overwrite the source route,
      // including when this task's Agent runs on another computer.
      expect(bindings.markRemoteSettingPersistedInsideHandler).toHaveBeenCalledOnce();
      expect(applyLive).not.toHaveBeenCalled();
      expect(runtimeStatus.model).toBe('old');
      if (!onOtherDevice) {
        expect(pending.get('s1').confirmedContextWindow).toBe(200000);
        // Axis-only restaging retains this route's receipt; a different route
        // must not inherit acknowledgement from the previous selection.
        bindings.confirmedContextWindow = undefined;
        await run();
        expect(pending.get('s1').confirmedContextWindow).toBe(200000);
        bindings.model = 'another-model';
        await run();
        expect(pending.get('s1')).not.toHaveProperty('confirmedContextWindow');
      }
      if (onOtherDevice) expect(bindings.assertAgentDeviceRouteUsable).toHaveBeenCalledWith('other', 'codex', 'new', 'provider');
      // Use the real send boundary: a running turn keeps the intent, the next
      // idle send applies it once instead of staging it again.
      let running = true;
      const deps = {
        pendingSwitches: { get: (id: string) => pending.get(id), clear: (id: string) => pending.delete(id) },
        getLiveSession: () => ({ isTurnRunning: () => running }),
        selectSameAgentModel: async (_id: string, _intent: unknown, applyNow: boolean) => {
          internalOptions.applyingUserSelectionOnSend = applyNow;
          return run();
        },
        log: { info: vi.fn(), warn: vi.fn() },
      } as unknown as MakerSessionAgentSwitchHandlerDeps;
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(applyLive).not.toHaveBeenCalled();
      expect(pending.has('s1')).toBe(true);
      running = false;
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(pending.has('s1')).toBe(false);
      await applyPendingAgentSwitchIfIdle(deps, 's1');
      expect(applyLive).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(onOtherDevice ? 1 : 3);
    }
  });

  it.each([undefined, 400000, 200000])('authorizes Orca local/final Pi rebuild only for the checked window: %s', confirmed => {
    expect(confirmationChecks).toHaveLength(2);
    for (const expression of confirmationChecks) {
      const check = new Function('runtimeStatus', 'internalOptions', 'isDeviceLinkInvoke',
        'confirmedContextWindow', 'targetContextWindow', 'finalPiWindow', 'parseOrcaRemoteLead', `return ${expression};`);
      for (const identity of orcaIdentities) {
        for (const remote of [false, true]) {
          expect(check(identity, { source: 'user', applyingUserSelectionOnSend: true },
            () => remote, confirmed, 200000, 200000, parseOrcaRemoteLead)).toBe(!remote && confirmed === 200000);
        }
      }
      expect(check({ orcaRole: null }, { source: 'user', applyingUserSelectionOnSend: true },
        () => false, confirmed, 200000, 200000, parseOrcaRemoteLead)).toBe(true);
    }
  });

  it('keeps the verified Pi window for execution-device Workers instead of trusting an old confirmation', () => {
    expect(piWindowOverride).not.toBe('');
    const check = new Function('runtimeStatus', 'isDeviceLinkInvoke', 'runtimeAgentKind',
      'confirmedContextWindow', 'targetContextWindow', 'parseOrcaRemoteLead',
      `${piWindowOverride}; return targetContextWindow;`);
    for (const identity of orcaIdentities) {
      expect(check(identity, () => false, 'pi', 400000, 200000, parseOrcaRemoteLead)).toBe(200000);
      expect(check(identity, () => false, 'pi', 400000, undefined, parseOrcaRemoteLead)).toBeUndefined();
    }
    expect(check({ orcaRole: null }, () => false, 'pi', 400000, 200000, parseOrcaRemoteLead)).toBe(400000);
  });

  it('retains intent when the send-time window still needs confirmation and retries with the new receipt', async () => {
    const pending = createPendingAgentSwitchRegistry();
    const apply = vi.fn(async (_id: string, _model: string, _provider: unknown, selection: { confirmedContextWindow?: number }) =>
      selection.confirmedContextWindow === 200000 ? { deferred: false } :
        { deferred: false, contextWindowConfirmationRequired: 200000 });
    const bindings = { applySessionRuntimeSelection: apply,
      throwIpcError: (_code: string, message: string) => { throw new Error(message); } };
    const code = ts.transpileModule(`return ${applySelectionAdapter};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const selectSameAgentModel = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    pending.set('s1', { sameAgentSelection: true, targetAgentKind: 'codex', model: 'small', providerId: 'provider' });
    const deps = { pendingSwitches: pending, getLiveSession: () => undefined, selectSameAgentModel,
      log: { info: vi.fn(), warn: vi.fn() } } as unknown as MakerSessionAgentSwitchHandlerDeps;
    await expect(applyPendingAgentSwitchIfIdle(deps, 's1')).rejects.toThrow('select the model again');
    expect(pending.get('s1')).toBeDefined();
    pending.set('s1', { ...pending.get('s1')!, confirmedContextWindow: 200000 });
    await applyPendingAgentSwitchIfIdle(deps, 's1');
    expect(pending.get('s1')).toBeUndefined();
    expect(apply.mock.calls[1][3]).toMatchObject({ confirmedContextWindow: 200000 });
  });
});
