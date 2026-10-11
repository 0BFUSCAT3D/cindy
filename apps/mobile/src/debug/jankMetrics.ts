/**
 * Interval counters for the local diagnostic log, aimed at "the app got slower the longer it ran".
 *
 * A `js stall` alone cannot tell which work starved the JS thread. While diagnostics are recording,
 * this keeps per-channel push handling time, business request counts and the remote session store's
 * retained size, and the diagnostic tick logs and resets them. Only fixed channel names and numbers
 * are kept: no payloads, arguments, device ids or session ids.
 *
 * Disabled (the default) every record call is a single boolean check.
 */

export interface RemoteSessionStoreSizeMetrics {
  /** Sessions holding an in-memory message window. */
  sessions: number;
  messages: number;
  /** Largest single in-memory window, the one every push to that task re-sorts. */
  maxSessionMessages: number;
  storeSubscribers: number;
}

interface ChannelTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

const TOP_CHANNELS = 6;

let enabled = false;
let pushes = new Map<string, ChannelTiming>();
let invokes = new Map<string, number>();
let storeSizeSource: (() => RemoteSessionStoreSizeMetrics) | null = null;

export function setJankMetricsEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  pushes = new Map();
  invokes = new Map();
}

export function jankMetricsEnabled(): boolean {
  return enabled;
}

export function recordPushHandled(channel: string, durationMs: number): void {
  if (!enabled) return;
  const entry = pushes.get(channel) ?? { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  pushes.set(channel, entry);
}

export function recordInvokeSent(channel: string): void {
  if (!enabled) return;
  invokes.set(channel, (invokes.get(channel) ?? 0) + 1);
}

/** The store registers itself so this module does not import the store's module graph. */
export function setRemoteSessionStoreSizeSource(
  source: () => RemoteSessionStoreSizeMetrics,
): void {
  storeSizeSource = source;
}

function topChannels<T>(
  map: Map<string, T>,
  weight: (value: T) => number,
): Record<string, T> {
  return Object.fromEntries(
    [...map]
      .sort((left, right) => weight(right[1]) - weight(left[1]))
      .slice(0, TOP_CHANNELS),
  );
}

/** Read and reset the interval counters. */
export function takeJankMetrics(): {
  store: RemoteSessionStoreSizeMetrics | null;
  pushCount: number;
  pushMs: number;
  pushes: Record<string, ChannelTiming>;
  invokeCount: number;
  invokes: Record<string, number>;
} {
  let pushCount = 0;
  let pushMs = 0;
  for (const entry of pushes.values()) {
    pushCount += entry.count;
    pushMs += entry.totalMs;
    entry.totalMs = Math.round(entry.totalMs);
    entry.maxMs = Math.round(entry.maxMs);
  }
  let invokeCount = 0;
  for (const count of invokes.values()) invokeCount += count;
  const snapshot = {
    store: storeSizeSource?.() ?? null,
    pushCount,
    pushMs: Math.round(pushMs),
    pushes: topChannels(pushes, (entry) => entry.totalMs),
    invokeCount,
    invokes: topChannels(invokes, (count) => count),
  };
  pushes = new Map();
  invokes = new Map();
  return snapshot;
}
