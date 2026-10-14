import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dropPendingBuild,
  hasPendingBuild,
  readPendingBuilds,
  recordPendingBuild,
  rewritePendingBuilds,
  settlePendingBuilds,
} from '../pendingBuild';
import { hasUnbuiltPersonalChanges } from '../buildRollback';
import { CindyMakeHistoryStore } from '../historyStore';
import type { MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cindy-pending-build-'));
  roots.push(directory);
  return directory;
}
const A = { commit: 'a'.repeat(40), tree: '1'.repeat(40) };
const B = { commit: 'b'.repeat(40), tree: '2'.repeat(40) };
const C = { commit: 'c'.repeat(40), tree: '3'.repeat(40) };

/** The account that integrated `changes`, as `recordAppliedMerge` records them. */
function account(directory: string, changes: Array<{ id: string; head: typeof A }>) {
  const store = new CindyMakeHistoryStore(path.join(directory, 'history'));
  store.seed({
    runId: 'task',
    sessionId: 'task',
    title: 'task',
    request: 'task',
    createdAt: 1,
    updatedAt: 1,
  });
  let before = { commit: '0'.repeat(40), tree: '0'.repeat(40) };
  for (const change of changes) {
    const receipt: MakeFeatureReceipt = {
      id: change.id,
      action: 'integrate',
      at: 1,
      baselineCommit: before.commit,
      commit: change.head.commit,
      beforeTree: before.tree,
      tree: change.head.tree,
      taskTree: change.head.tree,
    };
    recordPendingBuild(directory, change.head);
    store.receipt('task', receipt);
    before = change.head;
  }
  return store;
}

it('records the snapshot with its fact and keeps the newest entries', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  expect(readPendingBuilds(dir)).toEqual([A, B]);
  expect(hasPendingBuild(dir, A)).toBe(true);
  expect(hasPendingBuild(dir, C)).toBe(false);
});

it('a missing record proves nothing was recorded; an unreadable one proves nothing', () => {
  const dir = root();
  expect(readPendingBuilds(dir)).toEqual([]);
  expect(hasPendingBuild(dir, A)).toBe(false);
  mkdirSync(path.join(dir), { recursive: true });
  writeFileSync(path.join(dir, 'pending-build.json'), '{ not json');
  expect(readPendingBuilds(dir)).toBeUndefined();
  // Never "nothing pending": the caller fails closed as pending instead.
  expect(hasPendingBuild(dir, A)).toBeUndefined();
  // The next transition repairs it.
  settlePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toEqual([]);
});

it('a generated personal version settles the pending generation', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  settlePendingBuilds(dir);
  expect(readPendingBuilds(dir)).toEqual([]);
});

it('a completed rollback or restore drops the snapshot the source left', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  dropPendingBuild(dir, B);
  expect(readPendingBuilds(dir)).toEqual([A]);
});

it('an adopted rewrite carries the fact to the result that contains it', () => {
  const dir = root();
  recordPendingBuild(dir, A);
  recordPendingBuild(dir, B);
  rewritePendingBuilds(dir, [A.commit], C);
  expect(readPendingBuilds(dir)).toEqual([C, B]);
  expect(hasPendingBuild(dir, C)).toBe(true);
});

describe('the unbuilt-changes decision', () => {
  it('does not read the shared source through one account: another account still sees pending', () => {
    const dir = root();
    // Account A integrated `A`; the source carries it and no version covers it.
    const accountA = account(dir, [{ id: 'first', head: A }]);
    const accountB = new CindyMakeHistoryStore(path.join(dir, 'other-owner'));
    // The account that made the change sees it through its own receipts…
    expect(hasUnbuiltPersonalChanges(accountA, dir, A, () => false)).toBe(true);
    // …and another account of the same device must not conclude "nothing is
    // pending" just because its own history has no receipts for it.
    expect(hasUnbuiltPersonalChanges(accountB, dir, A, () => false)).toBe(true);
  });

  it('a snapshot fetched from another computer is pending until this one generates it', () => {
    const dir = root();
    // The adoption hook records the fetched snapshot (see `recordUnbuilt`): the
    // device has no build history for it at all.
    recordPendingBuild(dir, B);
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, B, () => false)).toBe(true);
    // This computer generated its own application from it: settled.
    expect(hasUnbuiltPersonalChanges(empty, dir, B, (commit) => commit === B.commit)).toBe(false);
  });

  it('a generated personal version settles the account facts too', () => {
    const dir = root();
    const store = account(dir, [{ id: 'first', head: A }]);
    settlePendingBuilds(dir);
    expect(hasUnbuiltPersonalChanges(store, dir, A, (commit) => commit === A.commit)).toBe(false);
  });

  it('a pending build rollback is still pending', () => {
    const dir = root();
    const store = account(dir, [{ id: 'first', head: A }]);
    store.saveBuildRollback([
      {
        runId: 'task',
        receipt: {
          id: 'first',
          action: 'integrate',
          at: 1,
          baselineCommit: '0'.repeat(40),
          commit: A.commit,
          beforeTree: '0'.repeat(40),
          tree: A.tree,
          taskTree: A.tree,
        },
      },
    ]);
    dropPendingBuild(dir, A); // even with the device record gone…
    expect(hasUnbuiltPersonalChanges(store, dir, A, () => true)).toBe(true); // …the rollback counts.
  });

  it('an unreadable record proves nothing: pending unless a version covers the snapshot', () => {
    const dir = root();
    mkdirSync(path.join(dir), { recursive: true });
    writeFileSync(path.join(dir, 'pending-build.json'), 'broken');
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, A, () => false)).toBe(true);
    expect(hasUnbuiltPersonalChanges(empty, dir, A, (commit) => commit === A.commit)).toBe(false);
  });

  it('an established snapshot with no facts is not pending', () => {
    const dir = root();
    const empty = new CindyMakeHistoryStore(path.join(dir, 'history'));
    expect(hasUnbuiltPersonalChanges(empty, dir, A, () => false)).toBe(false);
  });
});
