import { createAgentHandoffPendingRegistry, prependHandoffToUserMessage } from '@cindy/im-runtime/agentHandoff';
import type { UserMessage } from '@cindy/maker-core';
import { buildGoalInactiveNote, shouldPrependGoalInactiveNote } from '@cindy/im-runtime/goalInactiveNote';
import type { PlanReconcileCandidateRow } from '@cindy/im-runtime/planReconcile';
import type { TerminalTaskStorage } from './storage.js';

/** Context belongs to the persistent task, including when no UI is connected.
 * Accepted dispatches consume exactly the handoff read by that dispatch. */
export class TerminalTaskContext {
  readonly handoff;
  private readonly observed = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly host: {
    storage: TerminalTaskStorage;
    assertCurrent(): void;
    messages(id: string, limit: number): Promise<readonly PlanReconcileCandidateRow[]>;
    warn(message: string): void;
  }) {
    this.handoff = createAgentHandoffPendingRegistry(async id => {
      host.assertCurrent();
      const row = await host.storage.get(id);
      host.assertCurrent();
      const pending = row?.pendingHandoff;
      if (!row || row.deleted || !pending || pending.createdAt <= (row.clearedAt ?? 0)) return null;
      this.observed.set(id, pending.id);
      return pending.text;
    }, id => {
      const expected = this.observed.get(id);
      this.observed.delete(id);
      if (!expected) return;
      if (this.closed) { host.warn('Task context closed before handoff consumption'); return; }
      void this.enqueueAdmitted(() => host.storage.updateIf(id,
        row => row.pendingHandoff?.id === expected, { pendingHandoff: null }, () => {}),
      ).catch(() => host.warn('Accepted task handoff could not be marked consumed'));
    });
  }
  /** Call after committing a new handoff with the model change. */
  refresh(id: string) { this.observed.delete(id); this.handoff.clear(id); }
  async prepareHandoff(id: string, message: UserMessage) {
    const pending = await this.handoff.peek(id);
    this.host.assertCurrent();
    return { message: pending ? prependHandoffToUserMessage(message, pending) as UserMessage : message,
      accepted: () => { if (pending) this.handoff.consume(id); } };
  }
  async enqueue<T>(_label: string, write: () => T | Promise<T>): Promise<T> {
    this.host.assertCurrent();
    if (this.closed) throw new Error('TASK_CONTEXT_CLOSED');
    return this.enqueueAdmitted(write);
  }
  private enqueueAdmitted<T>(write: () => T | Promise<T>): Promise<T> {
    // Already admitted writes target this owner's fixed storage. Let them drain
    // at shutdown, especially the post-acceptance consumption marker.
    const operation = this.writes.then(write);
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }
  async peekGoalInactiveNote(id: string): Promise<string | null> {
    const [row, messages] = await Promise.all([this.host.storage.get(id), this.host.messages(id, 1000)]);
    this.host.assertCurrent();
    if (!row || row.deleted) return null;
    const latest = [...messages].reverse().find(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
    return shouldPrependGoalInactiveNote({ goal: row.goalContinuation ?? null, latestAssistantText: typeof latest?.content === 'string' ? latest.content : '' }) ? buildGoalInactiveNote() : null;
  }
  async close() { this.closed = true; await this.writes; }
}
