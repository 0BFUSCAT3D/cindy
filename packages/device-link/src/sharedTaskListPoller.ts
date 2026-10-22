/**
 * Cadence of the account shared-task directory on controlling clients. It only
 * discovers memberships: the server and the hosting Desktop enforce access, and
 * task content arrives through host pushes, independent of this interval.
 */
export const SHARED_TASK_LIST_ACTIVE_MS = 30_000;
export const SHARED_TASK_LIST_IDLE_MS = 60_000;
/** Returning to the foreground does not reread a list this recent. */
export const SHARED_TASK_LIST_RESUME_MIN_MS = 10_000;

export interface SharedTaskListPoller {
  /** Read now, e.g. after joining or reconnecting; while hidden, read on return. */
  refresh(): void;
  /** Call on foreground/background changes; reading pauses while hidden. */
  visibilityChanged(): void;
  dispose(): void;
}

export function startSharedTaskListPoller(options: {
  /** Resolves to the number of listed shared tasks, or null when the read failed. */
  poll(): Promise<number | null>;
  isVisible(): boolean;
}): SharedTaskListPoller {
  let disposed = false;
  let busy = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = SHARED_TASK_LIST_IDLE_MS;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (disposed || busy || !options.isVisible()) return;
    timer = setTimeout(() => { void run(); }, delay);
  };
  const run = async () => {
    if (disposed) return;
    // A refresh requested mid-read (e.g. a join) must not be lost to that read.
    if (busy) { again = true; return; }
    cancel();
    busy = true;
    try {
      do {
        again = false;
        lastReadAt = Date.now();
        const count = await options.poll().catch(() => null);
        if (count !== null) delay = count > 0 ? SHARED_TASK_LIST_ACTIVE_MS : SHARED_TASK_LIST_IDLE_MS;
      } while (again && !disposed);
    } finally { busy = false; }
    schedule();
  };
  if (options.isVisible()) void run();
  return {
    refresh() {
      if (options.isVisible()) void run();
      else lastReadAt = Number.NEGATIVE_INFINITY;
    },
    visibilityChanged() {
      if (!options.isVisible()) { cancel(); return; }
      const elapsed = Date.now() - lastReadAt;
      // A negative interval means the clock moved backwards; read rather than trust it.
      if (elapsed < 0 || elapsed >= SHARED_TASK_LIST_RESUME_MIN_MS) void run();
      else schedule();
    },
    dispose() { disposed = true; cancel(); },
  };
}
