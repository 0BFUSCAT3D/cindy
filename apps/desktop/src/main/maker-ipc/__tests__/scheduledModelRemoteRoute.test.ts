import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { applyScheduledModelSelection, createScheduledModelScope, resolveScheduledModelSelection, type ScheduledModelSelection } from '../scheduledModelSelection';

// #6745: execute the production adapter and persisted-scope restore together.
// A shared-provider baseline must use the execution computer's catalog.
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const adapters = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (node.name.getText(source) === 'applyScheduledProfile') adapters.set('scheduled', node.initializer.getText(source));
    if (node.name.getText(source) === 'reconcileBotModelRoute' && ts.isCallExpression(node.initializer)) {
      const deps = node.initializer.arguments[0] as ts.ObjectLiteralExpression;
      const apply = deps.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'apply') as ts.PropertyAssignment;
      adapters.set('bot', apply.initializer.getText(source));
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
function compile(key: string, bindings: Record<string, unknown>) {
  const js = ts.transpileModule(`return ${adapters.get(key)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const choice: ScheduledModelSelection = {
  agentKind: 'codex', model: 'test-model', providerId: 'openai-shared', effort: 'high', fastMode: false,
};
function catalog(id: string): ProviderView[] {
  return [{ id, connected: true, agents: ['codex'], source: 'user', models: { codex: [{
    id: 'test-model', efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: false,
  }] } }] as ProviderView[];
}
function fixture(device: string | null = 'share:test') {
  let current = { ...choice, agentDeviceId: device };
  let baseline: string | null = JSON.stringify({ ...choice, scopeId: 'old-run' });
  const local = catalog('openai');
  const remote = vi.fn(async () => catalog('openai-shared'));
  const guard = vi.fn(async (_agent: string, _model: string, providerId: string | null) => {
    if (!local.some(p => p.id === providerId)) throw new Error('provider unavailable on this computer');
    return undefined;
  });
  const query = { from: () => query, where: () => query, limit: async () => [{ planMode: false }] };
  const switchHarness = vi.fn(async (_deps: unknown, route: { agentDeviceId?: string | null }) => {
    if (route.agentDeviceId !== undefined) current.agentDeviceId = route.agentDeviceId;
    return { engineReady: true };
  });
  const applyModel = vi.fn(async (_id: string, model: string, providerId: string | null, axes: object) => {
    current = { ...current, model, providerId, ...axes };
    return {};
  });
  const apply = compile('scheduled', {
    applyScheduledModelSelection, resolveScheduledModelSelection,
    agentSwitchDeps: { getSessionRow: async () => ({ ...current, status: 'active' }) },
    dbToMakerAgentKind: (kind: string) => kind,
    isSessionInTurn: () => false, maker: { getSession: () => undefined },
    assertModelRouteUsable: guard, shouldApplyExclusiveProviderRerouteLive: () => false,
    resolveScheduledModelSelectionLive: async (route: ScheduledModelSelection) => resolveScheduledModelSelection(route, local),
    readUsableAgentDeviceProviders: remote,
    performSessionAgentSwitch: switchHarness, getDbClient: () => ({ drizzle: { select: () => query } }),
    sessions: {}, eq: vi.fn(), persistSessionFields: vi.fn(),
    applySessionRuntimeSelection: applyModel, runtimeSelectionRequiresModelWindowConfirmation: () => false,
  });
  const deps = {
    read: async () => ({ profile: current, baseline }),
    write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
    isBusy: () => false, createId: () => 'new-run', apply,
  };
  return { deps, remote, guard, switchHarness, applyModel, scope: createScheduledModelScope(deps),
    state: () => ({ current, baseline }), save: (value: unknown) => { baseline = JSON.stringify(value); } };
}

describe('automation restore uses the execution computer', () => {
  it.each(['share:test', 'other-device'])('restores a legacy baseline on %s after restart', async device => {
    const h = fixture(device);
    await createScheduledModelScope(h.deps).restore('task');
    expect(h.remote).toHaveBeenCalledWith(device, 'codex', 'test-model', 'openai-shared');
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.applyModel).toHaveBeenCalledOnce();
    expect(h.state().baseline).toBeNull();
    expect(h.state().current).toMatchObject(choice);
  });
  it('validates an automation choice on the same remote execution computer', async () => {
    const h = fixture();
    await h.deps.apply('task', choice);
    expect(h.remote).toHaveBeenCalledWith('share:test', 'codex', 'test-model', 'openai-shared');
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.state().current.agentDeviceId).toBe('share:test');
  });
  it('keeps ordinary local-provider validation for a local task', async () => {
    const h = fixture(null);
    h.save({ ...choice, providerId: 'openai', scopeId: 'old-run' });
    await h.scope.restore('task');
    expect(h.guard).toHaveBeenCalledWith('codex', 'test-model', 'openai');
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.state().current.providerId).toBe('openai');
    expect(h.state().baseline).toBeNull();
  });
  it('does not substitute a local provider when the remote catalog no longer contains the source', async () => {
    const h = fixture();
    h.remote.mockResolvedValueOnce(catalog('another-source'));
    await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.state().baseline).not.toBeNull();
  });
  it('retains the scope and task when the sharing host rejects access', async () => {
    const h = fixture();
    h.remote.mockRejectedValueOnce(new Error('REMOTE_AGENT_SHARE_PAUSED'));
    await expect(h.scope.restore('task')).rejects.toThrow('REMOTE_AGENT_SHARE_PAUSED');
    expect(h.state().baseline).not.toBeNull();
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
  });
  it('rejects a missing local provider without guessing a remote source', async () => {
    const h = fixture(null);
    await expect(h.scope.restore('task')).rejects.toThrow('provider unavailable');
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.state().baseline).not.toBeNull();
  });
});

describe('a new teammate preference supersedes the old automation baseline', () => {
  it.each([false, true])('clears the scope only after selection succeeds (fails=%s)', async fails => {
    const h = fixture();
    const originalBaseline = h.state().baseline;
    const stage = vi.fn(async () => {
      if (fails) throw new Error('unavailable');
      h.state().current.providerId = 'new-preference';
    });
    const clear = vi.fn(h.deps.write);
    const apply = compile('bot', {
      stageSessionRouteSelection: stage, updateScheduledPreference: clear, isSessionIdleForRouteApply: () => false,
    });
    const request = apply('task', { ...choice, agentDeviceId: 'share:new' }, choice);
    if (fails) {
      await expect(request).rejects.toThrow('unavailable');
      expect(clear).not.toHaveBeenCalled();
      expect(h.state().baseline).toBe(originalBaseline);
    } else {
      await request;
      expect(clear).toHaveBeenCalledExactlyOnceWith('task', null);
      expect(h.state().baseline).toBeNull();
      // The ordinary send's restore must leave the newly selected route intact.
      await h.scope.restore('task');
      expect(h.state().current.providerId).toBe('new-preference');
      expect(h.applyModel).not.toHaveBeenCalled();
    }
  });
});
