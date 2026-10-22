import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { applyScheduledModelSelection, createScheduledModelScope, createScheduledModelSelectionResolver, resolveScheduledModelSelection, type ScheduledModelSelection } from '../scheduledModelSelection';

// #6745: invoke the same production resolver wired into register.ts with the
// real persisted-scope lifecycle; only catalog, storage and engine I/O are fakes.
const choice: ScheduledModelSelection = {
  agentKind: 'codex', model: 'test-model', providerId: 'openai-shared', effort: 'high', fastMode: false,
};
function catalog(id: string): ProviderView[] {
  return [{ id, connected: true, agents: ['codex'], source: 'user', models: { codex: [{
    id: 'test-model', efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: false,
  }] } }] as ProviderView[];
}
function fixture(device: string | null = 'share:test', status = 'active') {
  let current = { ...choice, agentDeviceId: device };
  let baseline: string | null = JSON.stringify({ ...choice, scopeId: 'old-run' });
  const local = catalog('openai');
  const remote = vi.fn(async () => catalog('openai-shared'));
  const guard = vi.fn(async (_agent: string, _model: string, providerId: string | null) => {
    if (!local.some(p => p.id === providerId)) throw new Error('provider unavailable on this computer');
    return undefined;
  });
  const switchHarness = vi.fn(async () => ({ engineReady: true }));
  const applyModel = vi.fn(async (route: ScheduledModelSelection) => {
    current = { ...current, ...route };
  });
  const apply = async (_id: string, selection: ScheduledModelSelection) => applyScheduledModelSelection(selection, {
    getTarget: async () => status === 'missing' ? null : ({ ...current, status }),
    isBusy: () => false,
    resolveSelection: createScheduledModelSelectionResolver({
      readRemoteProviders: remote,
      resolveLocalSelection: async route => {
        await guard(route.agentKind, route.model, route.providerId);
        return resolveScheduledModelSelection(route, local);
      },
    }),
    switchHarness, applyModel,
  });
  const deps = {
    read: async () => ({ profile: current, baseline }),
    write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
    isBusy: () => false, createId: () => 'new-run',
    apply: async (id: string, profile: ScheduledModelSelection) => { await apply(id, profile); },
  };
  return { deps, apply, remote, guard, switchHarness, applyModel, scope: createScheduledModelScope(deps),
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
    await h.apply('task', choice);
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
  it('preserves the standard admission exception for a custom user-owned model group', async () => {
    const h = fixture();
    const views = catalog('openai-shared');
    const model = 'gpt-4o-audio-preview';
    views[0].models.codex![0].id = model;
    views[0].models.codex![0].group = 'custom:openai-shared';
    h.save({ ...choice, model, scopeId: 'old-run' });
    h.remote.mockResolvedValueOnce(views);
    await h.scope.restore('task');
    expect(h.state().baseline).toBeNull();
    expect(h.state().current).toMatchObject({ ...choice, model });
  });
  it.each([{ status: 'retired' }, { availability: 'requires_payment' }, { mode: 'image' }])(
    'rejects a remote catalog entry outside new-route admission: %j', async flags => {
      const h = fixture();
      const before = h.state();
      const views = catalog('openai-shared');
      Object.assign(views[0].models.codex![0], flags);
      h.remote.mockResolvedValueOnce(views);
      await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
      expect(h.state()).toEqual(before);
      expect(h.applyModel).not.toHaveBeenCalled();
      expect(h.switchHarness).not.toHaveBeenCalled();
    },
  );
  it.each(['provider', 'model'] as const)('preserves the baseline when the remote %s is disabled after restart', async disabled => {
    const h = fixture();
    const before = h.state();
    const views = catalog('openai-shared');
    if (disabled === 'provider') views[0].suspended = true;
    else views[0].models.codex![0].disabled = true;
    h.remote.mockResolvedValueOnce(views);
    await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
    expect(h.state()).toEqual(before);
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
  });
  it.each(['archived', 'deleted', 'missing'])('resolves the replacement locally for a %s target', async status => {
    const h = fixture('share:test', status);
    const before = h.state();
    h.remote.mockRejectedValue(new Error('REMOTE_AGENT_SHARE_PAUSED'));
    const localChoice = { ...choice, providerId: 'openai' };
    await expect(h.apply('task', localChoice)).resolves.toEqual(localChoice);
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.guard).toHaveBeenCalledWith('codex', 'test-model', 'openai');
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.state()).toEqual(before);
  });
  it.each(['archived', 'deleted'])('rejects a remote-only source for the local replacement of a %s target', async status => {
    const h = fixture('share:test', status);
    await expect(h.apply('task', choice)).rejects.toThrow('provider unavailable');
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
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
