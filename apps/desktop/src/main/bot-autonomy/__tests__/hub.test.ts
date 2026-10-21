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
import type { BotGlance } from '../../../shared/botAutonomy.js';

const h = vi.hoisted(() => ({
  scope: 'a', scheduler: 'sched' as string | null, ready: true,
  glance: vi.fn(),
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
  h.scope = 'a'; h.scheduler = 'sched'; h.ready = true;
  h.glance.mockReset().mockReturnValue({
    botId: 'sched', scope: 'all', waiting: [], working: [], lastSweepAt: 0, doneToday: 0, offlineDevices: [],
  } satisfies BotGlance);
  const bots = new Map([['sched', { status: 'active', allowSchedulerFollow: false }]]);
  h.readMetas.mockReset().mockResolvedValue([meta('mine'), meta('delegated'), meta('shared', 'shared')]);
  h.readOwnership.mockReset().mockResolvedValue({ bots, creatorBySession: new Map([['delegated', 'sched']]), responsibleByBot: new Map() });
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine,
    runtime: { glance: h.glance, watch: { isReady: () => h.ready, list: () => [], getBots: () => bots } } as unknown as BotAutonomyRuntime });
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

// #6508: the public glance reader must not report a successful empty workbench
// before its host/ownership is ready. Existing coverage only exercised follow-up
// authorization. Minimal unit inputs: missing, stale, or unready runtime.
it.each(['missing', 'stale', 'unready'] as const)('rejects a %s runtime instead of reporting no work', (state) => {
  if (state === 'missing') setActiveBotAutonomy(null);
  if (state === 'stale') h.scope = 'other';
  if (state === 'unready') h.ready = false;
  expect(() => getBotAutonomyGlance('sched')).toThrow(/\[PRECONDITION_FAILED\]/u);
  expect(h.glance).not.toHaveBeenCalled();
});

it('returns the actual empty projection once ready, preserving scope and visibility options', () => {
  const options = { excludeBotIds: new Set(['hidden']) };
  expect(getBotAutonomyGlance('sched', options)).toMatchObject({ botId: 'sched', scope: 'all', waiting: [], working: [] });
  expect(h.glance).toHaveBeenCalledWith('sched', options);
});
