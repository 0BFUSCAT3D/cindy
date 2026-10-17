import {
  historyPrefetchVersion,
  historySnapshotCovers,
  historySnapshotForCache,
  isHistoryViewUnavailable,
  selectHistoryPrefetchSessions,
} from '@cindy/maker-shared/message-window';
import { isSharedTaskPeer } from '@cindy/device-link';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { fitsHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from './remoteHistoryDiskCache';
import {
  detachedRemoteHistorySnapshot,
  dropDetachedRemoteHistoryView,
  isRemoteHistoryViewMounted,
} from './remoteHistoryViews';
import { remoteSessionStore } from './remoteSessionStore';

type Reader = Pick<MobileMakerTransport, 'readHistoryView'>;

// Activity version already read ahead, per device and task, valid only while the disk entry it
// was written to is current (sign-out, account switch and cache clears invalidate it). Memory only.
const prefetchedAt = new Map<string, { version: string; current(): boolean }>();
const keyFor = (deviceId: string, sessionId: string) => JSON.stringify([deviceId, sessionId]);
const running = new Map<string, { again: boolean; targets: Set<string> | null }>();

/**
 * After a list read that may follow missed pushes, read the latest history page of recently
 * changed tasks into the disk snapshot a task page restores on open. Sequential and best effort:
 * a failed read stops this run and is retried by the next refresh.
 */
export async function prefetchRemoteHistories(
  deviceId: string,
  reader: Reader,
  isCurrent: () => boolean,
  sessionIds?: ReadonlySet<string>,
): Promise<void> {
  if (!deviceId || isSharedTaskPeer(deviceId)) return;
  const run = running.get(deviceId);
  if (run) {
    run.again = true;
    if (!sessionIds) run.targets = null;
    else if (run.targets) for (const id of sessionIds) run.targets.add(id);
    return;
  }
  const state = { again: true, targets: sessionIds ? new Set(sessionIds) : null };
  running.set(deviceId, state);
  try {
    while (state.again && isCurrent()) {
      state.again = false;
      const targets = state.targets;
      state.targets = new Set<string>();
      const candidates = selectHistoryPrefetchSessions(
        remoteSessionStore.getSessions().filter((session) => session.deviceLinkDeviceId === deviceId),
        {
          limit: targets?.size,
          eligible: (session) => session.status === 'active' && session.pendingLocalCreation !== true
            && (!targets || (targets.has(session.id) && historyPrefetchVersion(session) !== undefined))
            && remoteSessionStore.getSessionRetention(session.id) === 'regular'
            && !isRemoteHistoryViewMounted(deviceId, session.id),
          prefetchedAt: (sessionId) => {
            const entry = prefetchedAt.get(keyFor(deviceId, sessionId));
            return entry?.current() ? entry.version : undefined;
          },
        },
      );
      for (const session of candidates) {
        if (!isCurrent()) return;
        const authority = historyDiskAuthority(deviceId, session.id);
        const previous = detachedRemoteHistorySnapshot(deviceId, session.id) ?? await readHistoryDisk(authority);
        if (!historySnapshotCovers(previous, session)) {
          const readAt = Date.now();
          let page;
          try {
            page = await reader.readHistoryView(session.id);
          } catch (error) {
            // A Host without the history view serves tasks the old way; nothing to read ahead.
            if (isHistoryViewUnavailable(error)) return;
            throw error;
          }
          if (!isCurrent() || isRemoteHistoryViewMounted(deviceId, session.id)) continue;
          const snapshot = historySnapshotForCache(page, previous, fitsHistoryDisk);
          if (!snapshot || !await writeHistoryDisk(authority, { ...snapshot, readAt })) continue;
          dropDetachedRemoteHistoryView(deviceId, session.id);
        }
        const version = historyPrefetchVersion(session);
        if (version !== undefined) prefetchedAt.set(keyFor(deviceId, session.id), { version, current: authority.current });
      }
    }
  } catch {
    // Offline or slow Host: the page opens through its normal read; the next refresh retries.
  } finally {
    running.delete(deviceId);
  }
}
