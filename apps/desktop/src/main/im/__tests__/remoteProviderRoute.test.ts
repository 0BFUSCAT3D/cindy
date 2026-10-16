import { beforeEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../device-link', () => ({ remoteBackgroundInvoke: invoke }));
import { readImRemotePermissionModes, readImRemoteProviderRoute } from '../remoteProviderRoute';

const route = { agentDeviceId: 'share:owner', agentKind: 'codex' as const, providerId: 'openai', model: 'shared-model' };
const provider = {
  id: 'openai', name: 'OpenAI', agents: ['codex'], connected: true,
  remoteInvocationEnabled: true, source: 'builtin',
  models: { codex: [{ id: 'shared-model', name: 'Shared model', efforts: ['high'], defaultEffort: 'high' }] },
};
beforeEach(() => invoke.mockReset());
it('reads permission modes from the execution host', async () => {
  invoke.mockResolvedValue({ ok: true, result: { permissionModes: [{ id: 'ask' }, { id: 'auto' }] } });
  await expect(readImRemotePermissionModes('share:owner', 'pi')).resolves.toEqual(['ask', 'auto']);
  expect(invoke).toHaveBeenCalledWith('share:owner', 'maker:get-capabilities', ['pi']);
});
it('rejects missing remote permission modes instead of broadening access', async () => {
  invoke.mockResolvedValue({ ok: true, result: {} });
  await expect(readImRemotePermissionModes('share:owner', 'pi')).rejects.toThrow('Invalid remote agent permission modes');
});
it('uses the authorized sharing catalog', async () => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [provider] } });
  await expect(readImRemoteProviderRoute(route)).resolves.toMatchObject({ provider: { id: 'openai' }, model: { id: 'shared-model' } });
  expect(invoke).toHaveBeenCalledWith('share:owner', 'maker:provider:list', expect.any(Array));
});
it.each([
  { connected: false }, { suspended: true }, { remoteInvocationEnabled: false },
  { models: { codex: [{ id: 'shared-model', disabled: true }] } },
  { models: { codex: [{ id: 'shared-model', mode: 'image_generation' }] } },
])('rejects an unavailable or non-chat shared route: %j', async (patch) => {
  invoke.mockResolvedValue({ ok: true, result: { providers: [{ ...provider, ...patch }] } });
  await expect(readImRemoteProviderRoute(route)).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
});
it('preserves the sharing failure reason', async () => {
  invoke.mockResolvedValue({ ok: false, error: { message: '[REMOTE_AGENT_SHARE_REMOVED] removed' } });
  await expect(readImRemoteProviderRoute(route)).rejects.toThrow('REMOTE_AGENT_SHARE_REMOVED');
});
