import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

/**
 * The device-level fact "the source at this snapshot carries personal changes
 * that are not generated on this computer yet and a failed generation could
 * still undo": recorded together with the source snapshot it describes, beside
 * the managed source (`makeSourceRoot`), never in the per-account build history.
 *
 * The managed source is shared by every Cindy account on the device while the
 * build history stays account-isolated, so "the current account has no receipts
 * for it" must never read as "the source has no pending generation". The
 * record's transitions keep the fact consistent with the source:
 *
 * - integrating a change records the resulting snapshot (before its receipt
 *   lands, so a crash in between never hides an unbuilt integration);
 * - generating a personal version settles the snapshot it was built from;
 * - a completed rollback or source restore drops the undone snapshot;
 * - an adopted rewrite (official update / combine) carries recorded snapshots
 *   over to the rewritten result that contains them.
 *
 * A missing record proves "never recorded"; an unreadable one proves nothing
 * and must never read as "nothing pending" (see `hasPendingBuild`). It is
 * repaired at the next transition.
 */

const FILE = 'pending-build.json';
const HASH = /^[0-9a-f]{40,64}$/i;
const MAX_FILE_BYTES = 256 * 1024;
/**
 * Generous bound against a damaged file growing without end. Newest entries are
 * kept: the snapshot the source is at is always the most recent one recorded,
 * and only a rollback chain longer than this could lose its oldest link.
 */
const MAX_SNAPSHOTS = 64;

export interface PendingBuildSnapshot {
  commit: string;
  tree: string;
}

const file = (root: string) => path.join(root, FILE);

/**
 * The recorded snapshots, oldest first. `[]` when none was ever recorded;
 * `undefined` when the record is unreadable — which proves nothing and must
 * never read as "nothing pending".
 */
export function readPendingBuilds(root: string): PendingBuildSnapshot[] | undefined {
  let info;
  try {
    info = lstatSync(file(root));
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return undefined;
  }
  const raw = readAtomicFileSync(file(root));
  if (raw === null) return [];
  if (raw.length > MAX_FILE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.schema !== 1 || !Array.isArray(input.snapshots)) return undefined;
  const snapshots: PendingBuildSnapshot[] = [];
  for (const entry of input.snapshots) {
    const snapshot = entry as { commit?: unknown; tree?: unknown } | null;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      typeof snapshot.commit !== 'string' ||
      !HASH.test(snapshot.commit) ||
      typeof snapshot.tree !== 'string' ||
      !HASH.test(snapshot.tree)
    )
      return undefined;
    snapshots.push({ commit: snapshot.commit, tree: snapshot.tree });
  }
  return snapshots;
}

function writePendingBuilds(root: string, snapshots: PendingBuildSnapshot[]): void {
  mkdirSync(root, { recursive: true });
  atomicWriteFileSync(file(root), JSON.stringify({ schema: 1, snapshots }));
}

/** The snapshot no longer exists in the source: its fact is stale. Absent record: nothing to do. */
export function dropPendingBuild(root: string, snapshot: { commit: string; tree?: string }): void {
  const known = readPendingBuilds(root);
  if (known === undefined) {
    // Repair an unreadable record at a transition: the source state it could not
    // describe has just been superseded anyway.
    writePendingBuilds(root, []);
    return;
  }
  const kept = known.filter((entry) => entry.commit !== snapshot.commit);
  if (kept.length !== known.length) writePendingBuilds(root, kept);
}

/**
 * The source moved to `snapshot` with changes that are not generated here yet.
 * Earlier snapshots stay recorded: a rollback chain steps back over them, and
 * each undone snapshot is dropped as the source leaves it.
 */
export function recordPendingBuild(root: string, snapshot: PendingBuildSnapshot): void {
  if (!HASH.test(snapshot.commit) || !HASH.test(snapshot.tree))
    throw new Error('Invalid pending build snapshot');
  const known = readPendingBuilds(root) ?? [];
  const entries = known.filter(
    (entry) => entry.commit !== snapshot.commit || entry.tree !== snapshot.tree,
  );
  entries.push(snapshot);
  writePendingBuilds(root, entries.slice(-MAX_SNAPSHOTS));
}

/**
 * A generated personal version settles the pending generation it was built
 * from, and with it every earlier snapshot its content carries: nothing left in
 * the source keeps waiting for a generation that already covered it. Source
 * moves queue behind the same project lock a build holds, so nothing can be
 * recorded against the built source in between.
 */
export function settlePendingBuilds(root: string): void {
  const known = readPendingBuilds(root);
  // An unreadable record is repaired here too: the generation that just
  // finished settles whatever it could not describe.
  if (known === undefined || known.length) writePendingBuilds(root, []);
}

/**
 * An adopted rewrite (official update / combine) carried the recorded changes
 * into its result: the fact follows the content to the snapshot that now holds it.
 */
export function rewritePendingBuilds(
  root: string,
  from: readonly string[],
  to: PendingBuildSnapshot,
): void {
  if (!HASH.test(to.commit) || !HASH.test(to.tree)) return;
  const known = readPendingBuilds(root) ?? [];
  const carried = new Set(from);
  const entries = known.map((entry) => (carried.has(entry.commit) ? to : entry));
  if (entries.some((entry) => entry === to)) {
    const unique = entries.filter(
      (entry, at) => entries.findIndex((other) => other === entry) === at,
    );
    writePendingBuilds(root, unique.slice(-MAX_SNAPSHOTS));
    return;
  }
  writePendingBuilds(root, entries.slice(-MAX_SNAPSHOTS));
}

/**
 * Whether the snapshot is recorded as carrying a pending generation. `undefined`
 * when the record cannot prove anything either way: the caller must then treat
 * the snapshot as pending unless a generated version already covers it.
 *
 * A commit names exactly one source snapshot, so the commit identifies the
 * record entry; the tree is kept with it as the snapshot's content identity.
 */
export function hasPendingBuild(
  root: string,
  head: { commit: string; tree: string },
): boolean | undefined {
  const known = readPendingBuilds(root);
  if (known === undefined) return undefined;
  return known.some((entry) => entry.commit === head.commit);
}
