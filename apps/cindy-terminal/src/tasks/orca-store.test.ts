/** Behavior tier: new terminal persistence has no Desktop SQL transaction.
 * Exercise real commits/restarts through its production adapter. Smallest
 * failures are two simultaneous leases, a task write interrupted after commit,
 * and an ended remote worker whose release has not yet been acknowledged. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalTaskStorage } from './storage.js';
import { TerminalOrcaStore } from './orca-store.js';
import { atomicPrivateWrite, privateDirectory } from '../platform.js';

const roots: string[] = [], stores: TerminalOrcaStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-orca-store-')); roots.push(root);
  const tasks = new TerminalTaskStorage(path.join(root, 'tasks')); await tasks.open();
  const task = async (id: string) => tasks.create({ id, title: id, workDir: root, model: 'fixture-model', agentKind: 'codex', permissionMode: 'ask' });
  await task('lead');
  let now = Date.now();
  const store = new TerminalOrcaStore({ root, tasks, guard() {}, now: () => now }); stores.push(store); await store.ready;
  const team = await store.createActiveTeam({ leadSessionId: 'lead' });
  return { root, tasks, task, store, team, advance(ms: number) { now += ms; } };
}
it('serializes label/slot reservations, retaining completed workers until their task is archived', async () => {
  const { store, task, tasks, team, advance } = await fixture();
  const lease = (id: string, label: string) => store.reserveWorkerCreation({ reservationId: id, teamId: team.id, label, hardLimit: 1, leaseMs: 100 });
  expect(await Promise.all([lease('first', 'Build'), lease('duplicate', 'BUILD'), lease('second', 'Review')])).toEqual([
    { ok: true, occupiedSlotsBefore: 0 }, { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' }, { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' },
  ]);
  advance(101); expect(await store.renewWorkerCreationReservation('first', 100)).toBe(false);
  expect(await lease('second', 'Review')).toMatchObject({ ok: true });
  await store.releaseWorkerCreationReservation('second'); await task('worker');
  await store.addOrUpdateWorker({ id: 'worker-one', teamId: team.id, sessionId: 'worker', label: 'Build', status: 'done' });
  expect(await lease('third', 'Review')).toMatchObject({ errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' });
  await tasks.update('worker', { archived: true });
  expect(await lease('third', 'Review')).toMatchObject({ ok: true });
  expect(await lease('fourth', 'BUILD')).toMatchObject({ errorCode: 'DUPLICATE_LABEL' });
});
it('replays one committed remote creation after an interrupted task write without duplicating the worker', async () => {
  const { root, store, tasks, team } = await fixture();
  await store.saveRemoteWorkerOpen('device', 'remote-task');
  vi.spyOn(tasks, 'create').mockRejectedValueOnce(new Error('fixture process exit after durable commit'));
  await expect(store.addRemoteWorker({ workerId: 'remote-worker', teamId: team.id, proxySessionId: 'proxy',
    deviceId: 'device', remoteSessionId: 'remote-task', label: 'Build', role: 'developer', proxySession: {
      title: 'Remote build', agentKind: 'cc', model: 'haiku', effort: null, permissionMode: 'auto', fastMode: false,
    } })).rejects.toThrow('fixture process exit');
  await expect(store.listWorkersByLead('lead')).rejects.toThrow('fixture process exit');
  await store.close();
  const reopenedTasks = new TerminalTaskStorage(path.join(root, 'tasks')); await reopenedTasks.open();
  const reopened = new TerminalOrcaStore({ root, tasks: reopenedTasks, guard() {} }); stores.push(reopened); await reopened.ready;
  expect(await reopened.listWorkersByLead('lead')).toMatchObject([{ id: 'remote-worker', sessionId: 'proxy', session: { agentKind: 'claude-code', title: 'Remote build' } }]);
  expect(await reopened.listOrphanRemoteWorkerOpens()).toEqual([]);
  expect((await reopenedTasks.list()).map(row => row.id).sort()).toEqual(['lead', 'proxy']);
  expect(JSON.parse(await readFile(path.join(root, 'orca', 'state.json'), 'utf8')).taskJournal).toEqual([]);
  await reopened.saveWorkerRemoteReport('remote-worker', { clientIds: ['accepted-input'], baselineMessageId: null });
  await reopened.markTeamEnded(team.id, 'completed');
  expect(await reopened.listActiveRemoteWorkers()).toEqual([]);
  expect(await reopened.listUnreleasedEndedRemoteWorkers()).toMatchObject([{ pendingReport: { clientIds: ['accepted-input'] } }]);
  await reopened.removeWorker('remote-worker');
  expect(await reopenedTasks.get('proxy')).toMatchObject({ archived: true, orcaRole: null });
  expect(await reopened.getWorkerRemoteReleaseState('remote-worker')).toMatchObject({ removeAfterRelease: true, remoteReleasedAt: null });
  await reopened.markWorkerRemoteStopConfirmed('remote-worker', 123);
  await reopened.markWorkerRemoteReleased('remote-worker', 124);
  await reopened.removeWorker('remote-worker');
  expect(await reopened.getRemoteWorkerByProxySession('proxy')).toBeNull();
  expect(await reopenedTasks.get('proxy')).not.toBeNull();
});
it('keeps focus and done/idle acknowledgements atomic and does not reopen an ended team', async () => {
  const { task, store, team, tasks, advance } = await fixture();
  expect(await store.isOrphanedTeamInit(team.id)).toBe(false); advance(60_000);
  expect(await store.isOrphanedTeamInit(team.id)).toBe(true);
  await task('worker-a'); await task('worker-b');
  for (const suffix of ['a', 'b']) await store.addOrUpdateWorker({ id: suffix, teamId: team.id, sessionId: `worker-${suffix}`, label: suffix });
  await Promise.all([store.setWorkerFocus(team.id, 'a'), store.setWorkerFocus(team.id, 'b')]);
  expect((await store.listWorkersByLead('lead')).filter(row => row.focused).map(row => row.id)).toEqual(['b']);
  await store.updateWorkerStatus('a', 'done'); expect(await store.markWorkerIdleIfStatus('a', 'done')).toBe(true);
  await store.updateWorkerStatus('a', 'running'); expect(await store.restoreWorkerDoneIfIdle('a')).toBe(false);
  expect((await store.listWorkersByLead('lead')).find(row => row.id === 'a')).toMatchObject({ status: 'running', idleSince: null });
  await store.markTeamEnded(team.id, 'cancelled');
  await expect(store.addOrUpdateWorker({ id: 'a', teamId: team.id, sessionId: 'worker-a' })).rejects.toThrow('ORCA_TEAM_NOT_FOUND');
  await store.reconcileInactiveTeamWorkersForLead('lead');
  expect(await store.isOrphanedTeamInit(team.id)).toBe(false);
  expect(await tasks.get('worker-a')).toMatchObject({ archived: true });
  expect(await store.getWorkerLink({ workerId: 'a' })).toMatchObject({ leadSessionId: 'lead', workerSessionId: 'worker-a' });
});
it('retains a failed startup as a permanent barrier instead of replacing corrupt data on the next call', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-orca-corrupt-')); roots.push(root);
  const tasks = new TerminalTaskStorage(path.join(root, 'tasks')); await tasks.open();
  await privateDirectory(path.join(root, 'orca')); const file = path.join(root, 'orca', 'state.json');
  await atomicPrivateWrite(file, '{interrupted');
  const store = new TerminalOrcaStore({ root, tasks, guard() {} }); stores.push(store);
  await expect(store.ready).rejects.toThrow();
  await expect(store.createActiveTeam({ leadSessionId: 'lead' })).rejects.toThrow();
  await expect(store.createActiveTeam({ leadSessionId: 'lead' })).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('{interrupted');
});
