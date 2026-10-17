import { useSyncExternalStore } from 'react';

export type LocalNetworkStatus = 'unknown' | 'available' | 'unavailable';
export type NetworkState = { type?: string; isConnected?: boolean; isInternetReachable?: boolean };

let snapshot: { status: LocalNetworkStatus } = { status: 'unknown' };
const listeners = new Set<() => void>();

/** Native network evidence only; a failed computer request cannot change this. */
export const localNetworkStore = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  update(network?: NetworkState) {
    // UNKNOWN may be a native lookup failure, including spurious false flags.
    const status: LocalNetworkStatus = !network?.type || network.type === 'UNKNOWN'
      ? 'unknown'
      : network.type === 'NONE' || network.isConnected === false || network.isInternetReachable === false
        ? 'unavailable'
        : network.isConnected === true ? 'available' : 'unknown';
    if (status === snapshot.status) return;
    snapshot = { status };
    for (const listener of listeners) listener();
  },
};

export function useLocalNetworkStatus(): LocalNetworkStatus {
  return useSyncExternalStore(localNetworkStore.subscribe, localNetworkStore.getSnapshot).status;
}
