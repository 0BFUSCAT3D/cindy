import { subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { NewSessionAgentKind, NewSessionRuntime } from './newSession';

export interface NewSessionHostDefaults {
  deviceId: string;
  byAgent: Partial<Record<NewSessionAgentKind, NewSessionRuntime | null>>;
}

// Display/default-selection snapshots only. Provider availability and submission
// still use the live catalog. Refresh on each visit without hiding cached values.
const cache = new Map<string, NewSessionHostDefaults>();
subscribeMobileAuthOwner(() => cache.clear());

export function getNewSessionHostDefaults(deviceId: string): NewSessionHostDefaults | null {
  return cache.get(deviceId) ?? null;
}

export function cacheNewSessionHostDefaults(
  next: NewSessionHostDefaults,
  expected: NewSessionHostDefaults | null,
): NewSessionHostDefaults {
  const current = getNewSessionHostDefaults(next.deviceId);
  // A choice made while the read was pending wins over its older response.
  if (current !== expected && current) return current;
  cache.set(next.deviceId, next);
  return next;
}

export function rememberNewSessionHostRuntime(deviceId: string, runtime: NewSessionRuntime): void {
  const current = cache.get(deviceId);
  if (!current) return;
  cache.set(deviceId, {
    ...current,
    byAgent: { ...current.byAgent, [runtime.agentKind]: runtime },
  });
}
