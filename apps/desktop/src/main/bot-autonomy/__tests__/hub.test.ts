/* Unit regression for cindy-bots-runtime §6.3: persisted queued completions must
 * survive watch eviction/restart, but current opt-out still revokes owner events.
 * Existing runtime tests inject dispatch and cannot exercise the hub's durable
 * authorization. Minimal input: empty watch + completed event + durable active
 * task/assignment. This owner-scoped IO fixture is separate from runtime's injected
 * watch fixture. Actual production hub is loaded once; only host IO is replaced.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotAutonomyRuntime } from '../runtime.js';
import type { RoutineEngine } from '@cindy/maker-scheduler';
import type { LocalSessionMeta } from '../taskWatch.js';

const h = vi.hoisted(() => ({
  scope: 'a', scheduler: 'sched' as string | null,
  readMetas: vi.fn(), readOwnership: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.scope, isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/unused-owner-root',
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
vi.mock('../../maker-host/bot-autonomy-settings-store.js', () => ({
  readBotAutonomySettingsOverride: () => ({ customized: true, schedulerBotId: h.scheduler }),
  resetBotAutonomySettings: vi.fn(), writeBotAutonomySchedulerBotId: vi.fn(),
}));
vi.mock('../hostData.js', () => ({
  readLocalSessionMetas: h.readMetas, readTaskOwnership: h.readOwnership, readBotDirectory: vi.fn(),
}));
import { currentFollowUpEvents, getBotAutonomyGlance, setActiveBotAutonomy } from '../hub.js';

const meta = (id: string, source = 'desktop'): LocalSessionMeta => ({
  id, source, title: 'Completed task', workingDir: null, status: 'active', hiddenAt: null,
  orcaRole: null, laneRole: null, laneBotId: null, interrupted: false,
  activeTurnStartedAt: 1, lastTurnEndedAt: 2,
});
const events = ['mine', 'delegated', 'shared', 'deleted'].map(subject => ({
  sourceId: 'host:sessions', event: { id: subject, type: 'finished', subject, occurredAt: 2, data: {} },
}));
beforeEach(() => {
  h.scope = 'a'; h.scheduler = 'sched';
  const bots = new Map([['sched', { status: 'active', allowSchedulerFollow: false }]]);
  h.readMetas.mockReset().mockResolvedValue([meta('mine'), meta('delegated'), meta('shared', 'shared')]);
  h.readOwnership.mockReset().mockResolvedValue({ bots, creatorBySession: new Map([['delegated', 'sched']]), responsibleByBot: new Map() });
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine,
    runtime: { watch: { isReady: () => true, list: () => [], getBots: () => bots } } as unknown as BotAutonomyRuntime });
});
afterEach(() => setActiveBotAutonomy(null));

it('dispatches persisted completions after restart without watch rows, but enforces current consent', async () => {
  const batch = await currentFollowUpEvents('sched', events);
  expect(batch?.events).toEqual([events[0], events[1]]);
  expect(batch?.canDispatch()).toBe(true);
  h.scheduler = null;
  expect(batch?.canDispatch()).toBe(false);
  const revoked = await currentFollowUpEvents('sched', events);
  expect(revoked?.events.map(item => item.event.subject)).toEqual(['delegated']);
  expect(revoked?.canDispatch()).toBe(true);
});

it('defers rather than authorizing a durable read that crossed the account boundary', async () => {
  h.readMetas.mockImplementationOnce(async () => { h.scope = 'b'; return [meta('mine')]; });
  expect(await currentFollowUpEvents('sched', events)).toBeNull();
});

// Unit §6.3: UI probe versus explicit view read, including an owner change while IO waits.
it('only refreshes remote state for an explicit scheduler workbench read and discards cross-account results', async () => {
  const remote = vi.fn(async () => {});
  const projection = { botId: 'sched', waiting: [] };
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine, runtime: {
    watch: { getSchedulerBotId: () => 'sched', refreshRemote: remote },
    glance: () => projection,
  } as unknown as BotAutonomyRuntime });
  expect(await getBotAutonomyGlance('sched', undefined, false)).toBe(projection);
  await getBotAutonomyGlance('own');
  expect(remote).not.toHaveBeenCalled();
  expect(await getBotAutonomyGlance('sched')).toBe(projection);
  expect(remote).toHaveBeenCalledOnce();
  remote.mockImplementationOnce(async () => { h.scope = 'b'; });
  expect(() => getBotAutonomyGlance('sched')).toThrow('PRECONDITION_FAILED');
});

// Unit regression for #6675: a nonresponding peer must not block the first cached
// glance. Existing immediate remote mocks cannot expose the unresolved IPC.
it('returns the cached glance while a remote peer is still pending or fails', async () => {
  let rejectRemote!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectRemote = reject; });
  const projection = { botId: 'sched', working: [{ sessionId: 'local' }] };
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine, runtime: {
    watch: { getSchedulerBotId: () => 'sched', refreshRemote: () => pending },
    glance: () => projection,
  } as unknown as BotAutonomyRuntime });
  try {
    // The detached permission handler also consumes this synchronous projection.
    expect(getBotAutonomyGlance('sched')).toBe(projection);
  } finally {
    rejectRemote(new Error('remote unavailable'));
    await Promise.resolve();
  }
  expect(await getBotAutonomyGlance('sched', undefined, false)).toBe(projection);
});
