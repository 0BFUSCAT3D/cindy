import { pluginWorkerCompletedAt } from '@cindy/orca-workflow/host/pluginWorkerCompletion';
import type { TerminalTaskHost } from './host.js';

/** Use host journal boundaries and the shared completion contract. A Worker
 * saying "done" or completing its ready placeholder is not a release receipt. */
export async function readTerminalWorkerCompletion(host: TerminalTaskHost, id: string, status: string) {
  const row = await host.storage.get(id);
  if (!row || row.deleted) throw new Error('TASK_NOT_FOUND');
  const messages = await host.invoke('local-db:messages:list', [id, { limit: Infinity }]) as Array<{
    clientId: string; rowid: number; role: string; content: string; createdAt: string; agentMeta: Record<string, unknown> | null;
  }>;
  const root = messages.filter(message => ['user', 'assistant'].includes(message.role) && !message.agentMeta?.parentUuid);
  const anchor = root[0], input = anchor && root.find(message => message.role === 'user' && message.rowid < anchor.rowid && !message.agentMeta?.autoResume);
  let cursor = 0, startedAt: number | null = null, endedAt: number | null = null;
  for (;;) {
    const page = await host.storage.history(id, cursor, 1000);
    for (const record of page.records) {
      const event = record.event;
      if (!input || record.clientId !== input.clientId || !event || event.turnScope === 'background') continue;
      const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
      if (event.type === 'status' && data.isRunning === true) { startedAt = record.timestamp; endedAt = null; }
      if (event.type === 'done' && data.silentStop !== true || event.type === 'error' && data.isTerminal !== false) endedAt = record.timestamp;
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  const flow = await host.invoke('maker:input:get-projection', [id]) as { pendingQueue: unknown[]; queuePaused: boolean };
  const completedAt = pluginWorkerCompletedAt({ status, working: host.isTurnRunning(id), queued: flow.pendingQueue.length, paused: flow.queuePaused,
    startedAt, endedAt, clearedAt: row.clearedAt,
    ...(anchor ? { anchor: { role: anchor.role, createdAt: Date.parse(anchor.createdAt), agentMeta: JSON.stringify(anchor.agentMeta) } } : {}),
    ...(input ? { taskInput: { createdAt: Date.parse(input.createdAt), content: input.content } } : {}) });
  const chronological = [...messages].reverse(), firstInput = chronological.find(message => message.role === 'user');
  const firstActivity = chronological.find(message => ['assistant', 'thinking', 'tool_use'].includes(message.role)
    && Date.parse(message.createdAt) >= (firstInput ? Date.parse(firstInput.createdAt) : row.createdAt));
  return { row, completedAt, status: completedAt !== null ? 'done' : status === 'done' ? 'idle' : status,
    startedAt, endedAt, acceptedAt: firstInput ? Date.parse(firstInput.createdAt) : undefined,
    firstActivityAt: firstActivity ? Date.parse(firstActivity.createdAt) : undefined };
}
