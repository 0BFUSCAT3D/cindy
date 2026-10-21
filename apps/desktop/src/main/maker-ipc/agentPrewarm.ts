/**
 * Agent 预热：用户在任务输入框开始打字时，提前启动这个任务的 Agent 进程，把
 * 1–4 秒的冷启动藏进打字时间里。本机任务与远程控制端的任务走同一入口。
 *
 * 只管理「预热出来、还没被真正发送用过」的进程：
 * - 同时最多保留 MAX_WARM 个，超出时关掉最早的那个；
 * - 预热后 IDLE_MS 内没有发送就关掉（用户继续打字会顺延）；
 * - 一旦有真实发送（markUsed），进程归正常生命周期管理，这里不再碰它。
 * 启动本身复用发送路径的懒创建，失败只记日志，下一次发送照常冷启动。
 */

export const AGENT_PREWARM_MAX_WARM = 2;
export const AGENT_PREWARM_IDLE_MS = 10 * 60_000;

export type AgentPrewarmOutcome = 'started' | 'warm' | 'skipped';

export interface AgentPrewarmDeps {
  /** Start the runtime if this task has none; true only when a new one was started. */
  start(sessionId: string, createOpts: unknown): Promise<boolean>;
  /** Close an unused prewarmed runtime; must leave a runtime that is doing work alone. */
  closeIfUnused(sessionId: string): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAgentPrewarmer(
  deps: AgentPrewarmDeps,
  opts: { maxWarm?: number; idleMs?: number } = {},
) {
  const maxWarm = opts.maxWarm ?? AGENT_PREWARM_MAX_WARM;
  const idleMs = opts.idleMs ?? AGENT_PREWARM_IDLE_MS;
  /** Insertion order is age order: the first key is the oldest unused runtime. */
  const warm = new Map<string, unknown>();
  const starting = new Map<string, Promise<AgentPrewarmOutcome>>();
  /** A real send took over while this task's prewarm was still starting. */
  const usedWhileStarting = new Set<string>();

  const untrack = (sessionId: string): boolean => {
    const timer = warm.get(sessionId);
    if (!warm.delete(sessionId)) return false;
    deps.clearTimer(timer);
    return true;
  };

  const release = (sessionId: string, reason: 'idle' | 'evicted') => {
    if (!untrack(sessionId)) return;
    void deps.closeIfUnused(sessionId).then(
      () => deps.log.info('agent prewarm released', { sessionId, reason }),
      (error: unknown) =>
        deps.log.warn('agent prewarm release failed', {
          sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const arm = (sessionId: string) => {
    const previous = warm.get(sessionId);
    if (previous !== undefined) deps.clearTimer(previous);
    warm.delete(sessionId);
    warm.set(
      sessionId,
      deps.setTimer(() => release(sessionId, 'idle'), idleMs),
    );
  };

  return {
    request(sessionId: string, createOpts: unknown): Promise<AgentPrewarmOutcome> {
      const pending = starting.get(sessionId);
      if (pending) return pending;
      if (warm.has(sessionId)) {
        // Still typing in the same task: keep its runtime for another full window.
        arm(sessionId);
        return Promise.resolve('warm');
      }
      // Tasks that are still starting count against the cap too, so a burst of
      // requests can never launch more than `maxWarm` runtimes at once: make room
      // by releasing the oldest unused one, or skip when only starts are in flight.
      while (warm.size + starting.size >= maxWarm) {
        const oldest = warm.keys().next().value;
        if (oldest === undefined) return Promise.resolve('skipped');
        release(oldest, 'evicted');
      }
      const run = (async (): Promise<AgentPrewarmOutcome> => {
        try {
          if (!(await deps.start(sessionId, createOpts))) return 'skipped';
        } catch (error) {
          deps.log.warn('agent prewarm failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          return 'skipped';
        }
        if (usedWhileStarting.delete(sessionId)) {
          // The send already owns this runtime; never hand it to idle reclaim.
          deps.log.info('agent prewarm taken over by send', { sessionId });
          return 'started';
        }
        arm(sessionId);
        deps.log.info('agent prewarm started', { sessionId, warm: warm.size });
        while (warm.size > maxWarm) {
          const oldest = warm.keys().next().value;
          if (oldest === undefined || oldest === sessionId) break;
          release(oldest, 'evicted');
        }
        return 'started';
      })().finally(() => {
        usedWhileStarting.delete(sessionId);
        if (starting.get(sessionId) === run) starting.delete(sessionId);
      });
      starting.set(sessionId, run);
      return run;
    },
    /** A real send now owns this runtime; prewarm bookkeeping must not close it. */
    markUsed(sessionId: string): void {
      untrack(sessionId);
      if (starting.has(sessionId)) usedWhileStarting.add(sessionId);
    },
    /** Account switch: the old owner's runtimes are torn down elsewhere. */
    reset(): void {
      for (const sessionId of [...warm.keys()]) untrack(sessionId);
    },
    warmSessionIds(): string[] {
      return [...warm.keys()];
    },
  };
}
