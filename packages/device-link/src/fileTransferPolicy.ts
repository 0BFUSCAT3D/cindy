import { FILE_PEER_IDLE_MS } from "./filePeer";

/** Existing command/receive budgets, now shared by route policy and both adapters.
 * These are bounded-wait product budgets, not claims about optimal network speed. */
export const FILE_PEER_COMMAND_TIMEOUT_MS = 15_000;
export const FILE_PEER_RECEIVE_TIMEOUT_MS = 60_000;
export const FILE_PEER_PROGRESS_SAMPLE_MS = 1000;
export type FileTransferPath = "direct" | "relay" | "unknown";

export function fileTransferPath(stats: unknown): FileTransferPath {
  try {
    const value = typeof stats === "string" ? JSON.parse(stats) : stats;
    return value?.path === "relay"
      ? "relay"
      : value?.path === "direct"
        ? "direct"
        : "unknown";
  } catch {
    return "unknown";
  }
}

/** Leave one command budget before the host expires a connection; old hosts use
 * their established 30s controller lifetime. Reject non-finite capability values. */
export function filePeerReuseMs(advertised: unknown, sessionBound?: unknown): number | null {
  // Explicit capability negotiation only: old peers must retain their idle budget.
  if (sessionBound === true) return null;
  return typeof advertised === "number" &&
    Number.isFinite(advertised) &&
    advertised >= FILE_PEER_RECEIVE_TIMEOUT_MS
    ? Math.min(FILE_PEER_IDLE_MS, advertised) - FILE_PEER_COMMAND_TIMEOUT_MS
    : FILE_PEER_RECEIVE_TIMEOUT_MS / 2;
}

/** Do not assume TURN is slower than OSS or invent a KB/s floor. Sample for one
 * command budget; only abandon a known path when its remaining work is projected
 * to exceed a full receive budget. No progress uses the shorter command budget.
 * A path change discards the old sample. Unknown paths only detect stalls.
 * This bounds a bad attempt; without OSS measurements it cannot promise a faster route. */
export function createFileTransferWatchdog(
  size: number,
  path: FileTransferPath | (() => FileTransferPath),
  now = Date.now,
) {
  let lastBytes = 0,
    lastProgress = now(),
    sampleAt = lastProgress,
    sampleBytes = 0;
  const getPath = typeof path === "function" ? path : () => path;
  let sampledPath = getPath();
  return (written: number): "stalled" | "slow-relay" | "slow-direct" | null => {
    const time = now();
    if (written > lastBytes) {
      lastBytes = written;
      lastProgress = time;
    }
    if (time - lastProgress >= FILE_PEER_COMMAND_TIMEOUT_MS) return "stalled";
    const currentPath = getPath();
    if (currentPath !== sampledPath) {
      sampledPath = currentPath;
      sampleAt = time;
      sampleBytes = written;
      return null;
    }
    const elapsed = time - sampleAt;
    if (elapsed < FILE_PEER_COMMAND_TIMEOUT_MS) return null;
    const advanced = written - sampleBytes;
    sampleAt = time;
    sampleBytes = written;
    if (advanced <= 0 || currentPath === "unknown") return null;
    const remainingMs = ((size - written) * elapsed) / advanced;
    return remainingMs > FILE_PEER_RECEIVE_TIMEOUT_MS
      ? currentPath === "relay"
        ? "slow-relay"
        : "slow-direct"
      : null;
  };
}

/** Validated by the host on every read; absent on older hosts, disabling reuse. */
export function validFileVersion(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
