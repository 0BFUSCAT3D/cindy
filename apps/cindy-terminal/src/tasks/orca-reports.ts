import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { formatOrcaWorkerCompletion, type WorkerTerminalTurnParams } from '@cindy/orca-workflow/host/orcaTeamService';
import type { DispatchOrcaInterAgentMessageParams, DispatchOrcaInterAgentMessageResult } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
import type { Submission, TerminalTaskStorage } from './storage.js';
import type { TerminalOrcaStore } from './orca-store.js';
import { assertTerminalOrcaInput } from './orca-input.js';

/** The accepted input owns its report. Both are kept in requests.json so a
 * daemon restart cannot forget the debt or invent a second Lead message. */
export class TerminalOrcaReports {
  private readonly context = new AsyncLocalStorage<{ id: string; requestId: string }>();
  private readonly deliveries = new Map<string, Promise<DispatchOrcaInterAgentMessageResult>>();
  private recovery?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly deps: {
    storage: TerminalTaskStorage; store: TerminalOrcaStore; guard(): void;
    dispatch(input: DispatchOrcaInterAgentMessageParams): Promise<DispatchOrcaInterAgentMessageResult>;
    withWorkerLock<T>(id: string, work: () => Promise<T>): Promise<T>;
    settled(id: string): void;
    warn(): void;
  }) {}
  async begin(id: string, requestId: string) {
    const receipt = await this.deps.storage.submission(id, requestId);
    if (receipt?.collaboration?.source !== 'lead') return;
    await this.deps.storage.changeOrcaReport(id, requestId, current => current ?? {
      phase: 'pending', clientId: `orca_report_${createHash('sha256').update(JSON.stringify([id, requestId])).digest('hex')}`,
    }, this.deps.guard);
  }
  async suppress(id: string, requestId?: string) {
    if (!requestId) return;
    const receipt = await this.deps.storage.submission(id, requestId);
    if (!receipt?.orcaReport) return;
    await this.deps.storage.changeOrcaReport(id, requestId, current => current && current.phase !== 'delivered'
      ? { ...current, phase: 'suppressed' } : current, this.deps.guard);
  }
  async terminal(id: string, requestId: string | undefined, turn: WorkerTerminalTurnParams, operation: () => Promise<void>) {
    const receipt = requestId ? await this.deps.storage.submission(id, requestId) : null;
    if (!receipt?.orcaReport || !requestId) return operation();
    if (turn.capture?.manualInterrupt) await this.suppress(id, requestId);
    else await this.prepare(id, requestId, formatOrcaWorkerCompletion(turn), turn.status);
    await this.context.run({ id, requestId }, operation);
    await this.markSettled(id, requestId);
  }
  async markSettled(id: string, requestId?: string) {
    if (!requestId) return;
    const report = (await this.deps.storage.submission(id, requestId))?.orcaReport;
    if (report?.phase !== 'delivered' || report.settled) return;
    await this.deps.storage.changeOrcaReport(id, requestId, current => current?.phase === 'delivered'
      ? { ...current, settled: true } : current, this.deps.guard);
  }
  private prepare(id: string, requestId: string, content: string, completion: 'done' | 'error') {
    return this.deps.storage.changeOrcaReport(id, requestId, current => current?.phase === 'pending'
      ? { ...current, phase: 'ready', content, completion } : current, this.deps.guard);
  }
  async manual(id: string, requestId: string | undefined, input: DispatchOrcaInterAgentMessageParams) {
    const receipt = requestId ? await this.deps.storage.submission(id, requestId) : null;
    if (!requestId || !receipt?.orcaReport || receipt.orcaReport.phase === 'delivered') return this.deps.dispatch(input);
    const prepared = await this.prepare(id, requestId, input.rawContent, 'done');
    const delivered = await this.deliver(id, requestId);
    // A newer progress message does not replace an earlier unacknowledged one.
    return delivered.ok && prepared?.content !== input.rawContent ? this.deps.dispatch(input) : delivered;
  }
  async automatic(input: DispatchOrcaInterAgentMessageParams) {
    const captured = this.context.getStore();
    if (captured) return this.deliver(captured.id, captured.requestId);
    // The shared service may defer its callback until dispatch commits. That
    // continuation can outlive the terminal event's async context.
    const link = input.workerId ? await this.deps.store.getWorkerLink({ workerId: input.workerId }) : null;
    const receipt = link ? (await this.deps.storage.reportSubmissions(link.workerSessionId)).at(-1) : undefined;
    if (!receipt) return this.deps.dispatch(input);
    if (receipt.orcaReport?.phase === 'pending') await this.prepare(receipt.sessionId, receipt.requestId, input.rawContent, 'done');
    return this.deliver(receipt.sessionId, receipt.requestId);
  }
  private deliver(id: string, requestId: string): Promise<DispatchOrcaInterAgentMessageResult> {
    const key = JSON.stringify([id, requestId]), existing = this.deliveries.get(key);
    if (existing) return existing;
    const work = this.performDelivery(id, requestId);
    this.deliveries.set(key, work);
    void work.finally(() => { if (this.deliveries.get(key) === work) this.deliveries.delete(key); }).catch(() => undefined);
    return work;
  }
  private async performDelivery(id: string, requestId: string): Promise<DispatchOrcaInterAgentMessageResult> {
    this.deps.guard();
    const receipt = await this.deps.storage.submission(id, requestId), report = receipt?.orcaReport, assignment = receipt?.collaboration;
    if (!assignment || assignment.source !== 'lead' || !report || report.phase === 'pending' || report.phase === 'suppressed' || !report.content) throw new Error('ORCA_REPORT_NOT_READY');
    await assertTerminalOrcaInput(this.deps.store, this.deps.storage, id, assignment);
    this.deps.guard();
    const accepted = await this.deps.storage.submission(assignment.leadSessionId, report.clientId);
    let result: DispatchOrcaInterAgentMessageResult;
    if (accepted) {
      // A lost local ACK must not reformat the sender or append a second input.
      // This includes inputs explicitly removed by the owner after delivery.
      if (accepted.collaboration?.workerId !== assignment.workerId || accepted.collaboration?.teamId !== assignment.teamId
        || accepted.collaboration?.source !== 'worker') throw new Error('ORCA_REPORT_RECEIPT_MISMATCH');
      result = { ok: true, mode: 'queued', clientId: report.clientId, dispatchOutcome: { kind: 'session-dispatch', source: 'orca', dispatched: true, wakeKind: 'queued' }, agentKind: (await this.deps.storage.get(assignment.leadSessionId))!.agentKind };
    } else {
      result = await this.deps.dispatch({ targetSessionId: assignment.leadSessionId, workerId: assignment.workerId,
        rawContent: report.content, source: 'worker', senderLabel: 'Worker', delivery: 'queue', clientId: report.clientId,
        meta: { source: 'orca', context: `worker_report/${id}/${requestId}` } });
    }
    if (result.ok) await this.deps.storage.changeOrcaReport(id, requestId, current => current?.clientId === report.clientId
      && current.phase === 'ready' ? { ...current, phase: 'delivered' } : current, this.deps.guard);
    return result;
  }
  start() {
    void this.recover().catch(this.deps.warn);
    this.timer = setInterval(() => { void this.recover().catch(this.deps.warn); }, 30_000);
    this.timer.unref();
  }
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    const work = this.restore(); this.recovery = work;
    void work.finally(() => { if (this.recovery === work) this.recovery = undefined; }).catch(() => undefined);
    return work;
  }
  private async restore() {
    for (const task of await this.deps.storage.list()) {
      this.deps.guard();
      if (task.archived || task.deleted) continue;
      const reports = await this.deps.storage.reportSubmissions(task.id);
      for (const receipt of reports) {
        if (receipt.orcaReport?.phase === 'suppressed' || receipt.orcaReport?.phase === 'delivered' && receipt.orcaReport.settled) continue;
        const assignment = receipt.collaboration!;
        try { await assertTerminalOrcaInput(this.deps.store, this.deps.storage, task.id, assignment); }
        catch (error) { if (error instanceof Error && error.message === 'ORCA_ASSIGNMENT_REVOKED') { await this.suppress(task.id, receipt.requestId); continue; } throw error; }
        if (receipt.orcaReport?.phase === 'pending') {
          if (!['completed', 'failed', 'interrupted'].includes(receipt.status)) continue;
          await this.restoreTerminal(receipt);
        }
        const delivered = receipt.orcaReport?.phase === 'delivered' || (await this.deliver(task.id, receipt.requestId)).ok;
        if (delivered) {
          await this.deps.withWorkerLock(task.id, async () => {
            const latest = (await this.deps.storage.reportSubmissions(task.id)).at(-1);
            const input = await this.deps.storage.latestSubmission(task.id);
            const worker = await this.deps.store.workerForLead(assignment.leadSessionId, assignment.workerId);
            // A new direct human turn has no report, but still owns its status.
            // Preserve idle acknowledgements and all newer assignments as well.
            if (input?.requestId === receipt.requestId && latest?.requestId === receipt.requestId
              && latest.orcaReport?.phase === 'delivered' && worker?.status === 'running') {
              this.deps.guard();
              await this.deps.store.updateWorkerStatus(assignment.workerId, latest.orcaReport?.completion ?? 'error');
              this.deps.settled(task.id);
            }
            await this.markSettled(task.id, receipt.requestId);
          });
        }
      }
    }
  }
  private async restoreTerminal(receipt: Submission) {
    let text = '', status: 'done' | 'error' = 'error', cursor = 0;
    for (;;) {
      const page = await this.deps.storage.history(receipt.sessionId, cursor, 1000);
      for (const record of page.records) {
        const event = record.event;
        if (record.clientId !== receipt.requestId || !event || event.turnScope === 'background') continue;
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
        if (event.type === 'text') {
          const part = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : '';
          text = data.isFinal === true ? part : text + part;
        }
        if (event.type === 'done' && data.silentStop !== true) status = 'done';
        if (event.type === 'error' && data.isTerminal !== false) status = 'error';
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    await this.prepare(receipt.sessionId, receipt.requestId, formatOrcaWorkerCompletion({ status, finalText: text || receipt.finalText || '',
      diagnostic: status === 'error' ? 'The server stopped before the Worker finished.' : undefined }), status);
  }
  async close() {
    clearInterval(this.timer);
    await Promise.allSettled([this.recovery, ...this.deliveries.values()]);
  }
}
