import { useEffect, useRef } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { prefetchRemoteHistories } from './remoteHistoryPrefetch';
import { remoteSessionStore } from './remoteSessionStore';

// Let the list refresh and any task the user taps right away go first.
const PREFETCH_DELAY_MS = 1500;

/** Coalesces reconnect and completed-task read ahead (renders nothing). */
export function RemoteHistoryPrefetchBridge() {
  const { invoke } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const latest = useRef({ invoke, accountGeneration });
  latest.current = { invoke, accountGeneration };
  useEffect(() => {
    const generation = accountGeneration;
    const isCurrent = () => latest.current.accountGeneration === generation;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending = new Map<string, Set<string> | null>();
    const unsubscribe = remoteSessionStore.onSessionHistoryPrefetchRequested((deviceId, sessionId) => {
      if (!sessionId) pending.set(deviceId, null);
      else if (pending.get(deviceId) !== null) {
        const ids = pending.get(deviceId) ?? new Set<string>();
        ids.add(sessionId);
        pending.set(deviceId, ids);
      }
      if (timers.has(deviceId)) return;
      timers.set(deviceId, setTimeout(() => {
        timers.delete(deviceId);
        const ids = pending.get(deviceId);
        pending.delete(deviceId);
        if (!isCurrent()) return;
        const reader = createMobileMakerTransport({ deviceId, invoke: latest.current.invoke, isCurrent });
        void prefetchRemoteHistories(deviceId, reader, isCurrent, ids ?? undefined);
      }, PREFETCH_DELAY_MS));
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [accountGeneration]);
  return null;
}
