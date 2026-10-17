import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'a', pending: false }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  ownerScopedUserDataPath: (name: string) => state.root + '/' + state.owner + '/' + name,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
import { readRemoteAgentLimitsState, saveRemoteAgentLimits } from '../host/limitsStore';
import { isRemoteAgentLimits } from '../../../shared/remoteAgentLimits';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-limit-store-'));
  state.owner = 'a'; state.pending = false;
});
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

describe('remote task limit overrides', () => {
  it('keeps explicit defaults, isolates accounts, and resets by deleting overrides', async () => {
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
    await saveRemoteAgentLimits({ perDevice: 16, total: 64 });
    expect(readRemoteAgentLimitsState().customizedKeys).toEqual(['perDevice', 'total']);
    await saveRemoteAgentLimits({ perDevice: 32, total: 128 });
    state.owner = 'b';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 16, total: 64 });
    state.owner = 'a';
    expect(readRemoteAgentLimitsState().value).toEqual({ perDevice: 32, total: 128 });
    await saveRemoteAgentLimits(null);
    expect(readRemoteAgentLimitsState()).toMatchObject({ isCustomized: false, value: { perDevice: 16, total: 64 } });
  });
  it.each([
    { perDevice: 0, total: 64 }, { perDevice: 2, total: 1 },
    { perDevice: 1.5, total: 64 }, { perDevice: 16, total: 1001 },
    { perDevice: NaN, total: 64 }, { perDevice: 16, total: Infinity },
  ])('rejects invalid settings %j', async value => {
    expect(isRemoteAgentLimits(value)).toBe(false);
    await expect(saveRemoteAgentLimits(value)).rejects.toThrow('INVALID_PARAMS');
    expect(readRemoteAgentLimitsState().isCustomized).toBe(false);
  });
  it('rejects writes during account teardown', async () => {
    state.pending = true;
    await expect(saveRemoteAgentLimits({ perDevice: 4, total: 8 })).rejects.toThrow('PRECONDITION_FAILED');
  });
});
