import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RemoteAgentCaps } from '@cindy/device-link';
import type { ProviderGroupConfig, ProviderGroupMemberState, ProviderGroupView } from '../../../shared/providerGroup';
import type { ProviderGroupOwnerScope } from '../runtime';
import { createGuestSupportReader, readSharedGroupStatus, SHARED_GROUP_STATUS_TIMEOUT_MS } from '../sharedStatus';

function setup(states: ProviderGroupMemberState[] = ['available', 'full', 'cooling', 'offline', 'paused', 'unavailable']) {
  let current = true;
  let config: ProviderGroupConfig | null = {
    strategy: 'least', autoSwitch: true,
    members: states.map((state, index) => ({
      key: `private-key-${index}`, label: `Secret Computer ${index}`, kind: index === 0 ? 'local' : 'device',
      agentDeviceId: index === 0 ? null : `private-device-${index}`, providerId: 'anthropic',
      limit: 4, weight: 1, paused: state === 'paused',
    })),
  };
  const view: ProviderGroupView = {
    providerId: 'anthropic', config, members: config.members.map((member, index) => ({
      ...member, label: member.label!, ownerName: 'private-owner', state: states[index], running: index === 1 ? 4 : 0,
    })),
  };
  const router = { view: vi.fn(async () => view) };
  const readCaps = vi.fn(async () => ({ virtualWorkspace: true, guestRelay: true }) as RemoteAgentCaps);
  const isIncapable = vi.fn(() => false);
  const deps = {
    scope: () => ({ router, isCurrent: () => current }) as unknown as ProviderGroupOwnerScope,
    readGroup: () => config, readCaps, isIncapable,
  };
  return {
    deps, router, view, readCaps, isIncapable,
    changeOwner: () => { current = false; },
    removeGroup: () => { config = null; },
    setConfig: (next: ProviderGroupConfig) => { config = next; },
  };
}

afterEach(() => vi.useRealTimers());

describe('anonymous shared group status', () => {
  it('coalesces capability reads per computer without caching across detail refreshes', async () => {
    const env = setup(['available', 'available']);
    const member = env.view.config!.members[1];
    const read = createGuestSupportReader(env.readCaps);
    expect(await Promise.all([read(member), read({ ...member, providerId: 'other' })])).toEqual(['supported', 'supported']);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true } as RemoteAgentCaps);
    expect(await createGuestSupportReader(env.readCaps)(member)).toBe('needs-update');
  });

  it('projects coarse states without identities, sources, limits, or usage', async () => {
    const env = setup();
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual([
      'available', 'busy', 'cooling', 'offline', 'paused', 'unavailable',
    ]);
    expect(env.readCaps).toHaveBeenCalledTimes(1);
  });

  it('checks guest compatibility even when the owner can use the computer', async () => {
    const env = setup(['available', 'available']);
    env.readCaps.mockResolvedValue({ virtualWorkspace: true } as RemoteAgentCaps);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    // A shared member is already isolated by its host and does not require guestRelay.
    env.view.config!.members[1].kind = 'share';
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'busy']);
    env.readCaps.mockResolvedValue({ guestRelay: true } as RemoteAgentCaps);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
  });

  it('reflects the same temporary exclusion as the guest router without probing or changing it', async () => {
    const env = setup(['available', 'available']);
    env.isIncapable.mockReturnValue(true);
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toEqual(['available', 'needs-update']);
    expect(env.readCaps).not.toHaveBeenCalled();
  });

  it('keeps confirmed statuses while an unresponsive capability read becomes unknown', async () => {
    vi.useFakeTimers();
    const env = setup(['available', 'available']);
    env.readCaps.mockImplementation(() => new Promise(() => {}));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await result).toEqual(['available', 'unknown']);
  });

  it('bounds a failed/slow group read without declaring computers available', async () => {
    vi.useFakeTimers();
    const env = setup();
    env.router.view.mockImplementation(() => new Promise(() => {}));
    const result = readSharedGroupStatus(env.deps, 'anthropic');
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect(await result).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'paused', 'unknown']);
    expect(env.readCaps).not.toHaveBeenCalled();
  });

  it('discards status when ownership or group membership changes during the read', async () => {
    const env = setup();
    env.readCaps.mockImplementation(async () => {
      env.changeOwner();
      return { virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps;
    });
    expect(await readSharedGroupStatus(env.deps, 'anthropic')).toBeNull();
    const changed = setup();
    changed.readCaps.mockImplementation(async () => {
      changed.setConfig({ ...changed.view.config!, members: [...changed.view.config!.members].reverse() });
      return { virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps;
    });
    expect(await readSharedGroupStatus(changed.deps, 'anthropic')).toBeNull();
    changed.removeGroup();
    expect(await readSharedGroupStatus(changed.deps, 'anthropic')).toBeNull();
  });
});
