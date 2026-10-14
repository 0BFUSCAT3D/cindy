import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { applyPendingAgentSwitchIfIdle, type MakerSessionAgentSwitchHandlerDeps } from '../sessionAgentSwitchHandler';

// Execute the actual picker admission branches (local and agent-device), with
// everything after admission represented by applyLive. No Electron bootstrap.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const branches: string[] = [];
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(source).includes('!internalOptions.applyingUserSelectionOnSend')
    && node.thenStatement.getText(source).includes('pendingUntilSend: true')) {
    branches.push(node.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);

describe('Orca model-only picker intent admission', () => {
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
      const run = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
      expect(await run()).toMatchObject({ deferred: true, pendingUntilSend: true });
      expect(pending.get('s1')).toMatchObject({ sameAgentSelection: true, targetAgentKind: 'codex',
        model: 'new', providerId: 'provider', effort: 'high', fastMode: true });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(applyLive).not.toHaveBeenCalled();
      expect(runtimeStatus.model).toBe('old');
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
      expect(changed).toHaveBeenCalledTimes(1);
    }
  });
});
