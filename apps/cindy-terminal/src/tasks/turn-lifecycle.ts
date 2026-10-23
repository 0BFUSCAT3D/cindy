import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger, SendOrigin, Session } from '@cindy/maker-core';
import { SILENT_STOP_RESUME_PROMPT, SilentStopAutoResumeGuard } from '@cindy/remote-agent/host/silentStopAutoResume';

type Reason = 'exhausted' | 'skip' | 'send-failed';
type PendingContinuation = {
  session: Session; generation: number; doneAt: number; origin?: SendOrigin;
  timer?: ReturnType<typeof setTimeout>; controller: AbortController; dispatching: boolean;
};

/** A silent vendor terminal keeps the same logical task occupied until bounded
 * continuation completes or the owner explicitly stops it. */
export class TerminalTurnLifecycle {
  private readonly guard;
  private readonly pending = new Map<string, PendingContinuation>();
  private readonly listeners = new Map<string, Set<(id: string, reason: Reason) => void>>();
  constructor(private readonly host: {
    profileDir: string;
    logger: Logger;
    assertCurrent(): void;
    beforeStart(session: Session): Promise<void>;
    undispatched(session: Session): void | Promise<void>;
    providerInitiated(session: Session): void;
    hasQueuedWork(sessionId: string): boolean;
    persistContinuation(session: Session, text: string, origin?: SendOrigin): Promise<void>;
    settled(session: Session, reason: Reason): Promise<void>;
  }) {
    this.guard = new SilentStopAutoResumeGuard({ log: host.logger, isEnabled: () => {
      try { return JSON.parse(readFileSync(path.join(host.profileDir, 'silent-stop-auto-resume-settings.json'), 'utf8')).enabled !== false; }
      catch { return true; }
    } });
  }
  running(id: string) { return this.pending.has(id); }
  noteUserSend(id: string) { this.guard.noteUserSend(id); }
  onSettled(id: string, listener: (id: string, reason: Reason) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private cancel(record: PendingContinuation, abort = false) {
    if (record.timer) clearTimeout(record.timer);
    if (abort) record.controller.abort();
    if (this.pending.get(record.session.id) === record) this.pending.delete(record.session.id);
    record.session.settleHostTurnContinuation(record.generation);
  }
  bind(session: Session) {
    session.setTurnLifecycleObserver({
      beforeProviderStart: async () => {
        this.host.assertCurrent();
        await this.host.beforeStart(session);
        this.host.assertCurrent();
        const prior = this.pending.get(session.id);
        if (prior && !prior.dispatching) this.cancel(prior);
        this.guard.noteTurnStarted(session.id);
      },
      onUndispatched: async () => {
        // An unsuccessful continuation still belongs to the original patch;
        // its failure settlement seals it. A fresh send can discard its anchor.
        if (!this.pending.get(session.id)?.dispatching) await this.host.undispatched(session);
      },
      onProviderInitiatedTurn: () => this.host.providerInitiated(session),
      onTerminal: ({ turnGeneration, event, isCurrentGeneration }) => {
        if (!isCurrentGeneration || event.turnScope === 'background') return;
        const previous = this.pending.get(session.id);
        if (event.type !== 'done' || (event.data as { silentStop?: boolean } | undefined)?.silentStop !== true) {
          if (previous) this.cancel(previous);
          return;
        }
        if (previous?.session === session && previous.generation === turnGeneration) return;
        if (previous) this.cancel(previous);
        const record: PendingContinuation = { session, generation: turnGeneration, doneAt: Date.now(), origin: event.turnOrigin, controller: new AbortController(), dispatching: false };
        this.pending.set(session.id, record);
        session.claimHostTurnContinuation(turnGeneration);
        record.timer = setTimeout(() => { void this.resume(record).catch(() => this.host.logger.warn('Task continuation could not settle')); }, 1_500);
        record.timer.unref();
      },
    });
    return () => {
      const record = this.pending.get(session.id);
      if (record?.session === session) this.cancel(record);
      session.setTurnLifecycleObserver(null);
    };
  }
  private current(record: PendingContinuation) {
    try { this.host.assertCurrent(); } catch { return false; }
    return !record.controller.signal.aborted && this.pending.get(record.session.id) === record && record.session.getStatus() === 'active' && record.session.getTurnGeneration() === record.generation;
  }
  private async resume(record: PendingContinuation) {
    if (!this.current(record)) { this.cancel(record, true); return; }
    const session = record.session;
    const decision = this.host.hasQueuedWork(session.id) ? { action: 'skip' as const } : this.guard.onSilentStop(session.id, record.doneAt);
    if (decision.action !== 'resume') { await this.settle(record, decision.action === 'exhausted' ? 'exhausted' : 'skip'); return; }
    record.dispatching = true;
    try {
      const result = await session.sendHostTurnContinuation({ type: 'user', content: SILENT_STOP_RESUME_PROMPT }, {
        signal: record.controller.signal, origin: record.origin,
        onAccepted: () => this.host.persistContinuation(session, SILENT_STOP_RESUME_PROMPT, record.origin),
      });
      if (!result.accepted) {
        this.guard.noteResumeSendFailed(session.id);
        await this.settle(record, 'send-failed');
      } else if (this.pending.get(session.id) === record) {
        // The new generation owns terminal delivery. Do not abort its signal.
        this.pending.delete(session.id);
      }
    } catch {
      this.guard.noteResumeSendFailed(session.id);
      await this.settle(record, 'send-failed');
    }
  }
  private async settle(record: PendingContinuation, reason: Reason) {
    if (!this.current(record)) return;
    this.cancel(record);
    await this.host.settled(record.session, reason);
    for (const listener of this.listeners.get(record.session.id) ?? []) {
      try { listener(record.session.id, reason); } catch { this.host.logger.warn('Channel continuation listener failed'); }
    }
  }
  async stop(session: Session) {
    const record = this.pending.get(session.id);
    this.guard.noteSessionReset(session.id);
    if (record) this.cancel(record, true);
    await session.abort();
    if (record) {
      await this.host.settled(session, 'skip');
      for (const listener of this.listeners.get(session.id) ?? []) {
        try { listener(session.id, 'skip'); } catch { this.host.logger.warn('Channel stop listener failed'); }
      }
    }
  }
  close() { for (const record of this.pending.values()) this.cancel(record, true); this.listeners.clear(); }
}
