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
import { readRemoteAgentIdleReleaseMinutes, readRemoteAgentIdleReleaseState, saveRemoteAgentIdleRelease } from '../controller/idleReleaseStore';

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-idle-release-store-'));
  state.owner = 'a'; state.pending = false;
});
afterEach(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

describe('idle release setting', () => {
  it('defaults to 10 minutes, keeps explicit choices per account and resets by deleting the override', async () => {
    expect(readRemoteAgentIdleReleaseState()).toEqual({ value: { idleMinutes: 10 }, defaults: { idleMinutes: 10 }, isCustomized: false });
    await saveRemoteAgentIdleRelease({ idleMinutes: 0 });
    expect(readRemoteAgentIdleReleaseMinutes()).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(state.root, 'a', 'remote-agent-idle-release.json'), 'utf8'))).toEqual({ idleMinutes: 0 });
    await saveRemoteAgentIdleRelease({ idleMinutes: 10 });
    expect(readRemoteAgentIdleReleaseState().isCustomized).toBe(true);
    state.owner = 'b';
    expect(readRemoteAgentIdleReleaseState().isCustomized).toBe(false);
    state.owner = 'a';
    await saveRemoteAgentIdleRelease(null);
    expect(readRemoteAgentIdleReleaseState()).toMatchObject({ value: { idleMinutes: 10 }, isCustomized: false });
  });

  it('rejects invalid values and refuses saves during an account change', async () => {
    await expect(saveRemoteAgentIdleRelease({ idleMinutes: 121 })).rejects.toThrow('INVALID_PARAMS');
    state.pending = true;
    await expect(saveRemoteAgentIdleRelease({ idleMinutes: 5 })).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('treats a hand-edited invalid file as the default', async () => {
    await fs.mkdir(path.join(state.root, 'a'), { recursive: true });
    await fs.writeFile(path.join(state.root, 'a', 'remote-agent-idle-release.json'), JSON.stringify({ idleMinutes: 999 }));
    expect(readRemoteAgentIdleReleaseMinutes()).toBe(10);
  });
});
