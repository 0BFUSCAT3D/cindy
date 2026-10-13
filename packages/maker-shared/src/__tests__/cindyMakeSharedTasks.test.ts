import { expect, it, vi } from 'vitest';
import { filterCindyMakeSharedTasks } from '../cindyMakeFeature';

const task = { sessionId: 'task', hostDeviceId: 'offline-host', title: 'Share' };
const options = () => ({
  knownSession: vi.fn<() => { id: string; source?: string | null } | undefined>(() => undefined),
  readSession: vi.fn<() => Promise<{ id: string; source?: string } | null>>(async () => null),
  isCurrent: vi.fn(() => true),
});

it.each(['cindy-make', 'cindy-make-merge'])('hides a legacy share confirmed as %s by the old host', async source => {
  const reader = options();
  reader.readSession.mockResolvedValue({ id: task.sessionId, source });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
});

it.each(['cindy-make', 'cindy-make-merge'])('uses the unfiltered cached %s source even with an offline host', async source => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId, source });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.readSession).not.toHaveBeenCalled();
});

it.each(['offline', 'missing', 'wrong-task'])('keeps an unconfirmed %s share hidden and retries on recovery', async reason => {
  const reader = options();
  if (reason === 'offline') reader.readSession.mockRejectedValueOnce(new Error('offline'));
  if (reason === 'wrong-task') reader.readSession.mockResolvedValueOnce({ id: 'other-task', source: 'desktop' });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  reader.readSession.mockResolvedValue({ id: task.sessionId, source: 'desktop' });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([{ ...task, source: 'desktop' }]);
});

it('confirms a matching legacy ordinary task whose successful metadata omits source', async () => {
  const reader = options();
  reader.knownSession.mockReturnValue({ id: task.sessionId });
  reader.readSession.mockResolvedValue({ id: task.sessionId });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([{ ...task, source: null }]);
  expect(reader.readSession).toHaveBeenCalledExactlyOnceWith(task);
});

it('does not publish an old account response or start new reads after invalidation', async () => {
  const reader = options();
  let current = true;
  reader.isCurrent.mockImplementation(() => current);
  reader.readSession.mockImplementation(async () => { current = false; return { id: task.sessionId, source: 'desktop' }; });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  reader.readSession.mockClear();
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
  expect(reader.readSession).not.toHaveBeenCalled();
});

it('does not let a delayed read override newly arrived hidden source metadata', async () => {
  const reader = options();
  reader.readSession.mockImplementation(async () => {
    reader.knownSession.mockReturnValue({ id: task.sessionId, source: 'cindy-make' });
    return { id: task.sessionId, source: 'desktop' };
  });
  expect(await filterCindyMakeSharedTasks([task], reader)).toEqual([]);
});
