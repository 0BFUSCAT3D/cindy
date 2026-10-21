import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mayHave: vi.fn(() => true),
}));

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/device-link/mobileMakerTransport', () => ({
  createMobileMakerTransport: () => ({ schedule: { list: mocks.list } }),
}));
vi.mock('@/session/scheduleIndex', () => ({ sessionMayHaveScheduleRuns: mocks.mayHave }));

import {
  countSessionsWithActiveBoundSchedules,
  loadActiveBoundScheduleNames,
  SCHEDULE_LOOKUP_WAIT_MS,
} from '@/session/archiveScheduleConfirm';

const args = { deviceId: 'pc', invoke: vi.fn(), sessionId: 'task' } as never;

describe('archive schedule lookup deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.list.mockReset();
    mocks.mayHave.mockReturnValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('treats a slow list request as no binding instead of blocking archive', async () => {
    mocks.list.mockReturnValue(new Promise(() => {}));

    const single = loadActiveBoundScheduleNames(args);
    const bulk = countSessionsWithActiveBoundSchedules({ schedule: { list: mocks.list } } as never, ['task']);
    await vi.advanceTimersByTimeAsync(SCHEDULE_LOOKUP_WAIT_MS);

    await expect(single).resolves.toEqual([]);
    await expect(bulk).resolves.toBe(0);
  });

  it('still reports active non-persistent bindings that arrive in time', async () => {
    mocks.list.mockResolvedValue([
      { id: 'a', name: 'Daily', status: 'active', targetSessionId: 'task' },
      { id: 'b', name: 'Persistent', status: 'active', targetSessionId: 'task', persistentSession: true },
    ]);

    await expect(loadActiveBoundScheduleNames(args)).resolves.toEqual(['Daily']);
  });

  it('skips the request for tasks known to be unbound', async () => {
    mocks.mayHave.mockReturnValue(false);

    await expect(loadActiveBoundScheduleNames(args)).resolves.toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
