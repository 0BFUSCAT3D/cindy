import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { UserMessage } from '@cindy/maker-core';
import type { AgentInputQueuedMessage, AgentInputSerializedFile } from '@cindy/maker-shared/agent-input-queue';
import type { TerminalTaskStorage, Submission, QueuedSubmissionPatch } from './storage.js';
import type { TerminalOrcaStore } from './orca-store.js';
import { captureTerminalOrcaInput, terminalOrcaHistoryMessage } from './orca-input.js';
import { inputPlainText, persistedInput } from './input.js';

/** Shared Orca controls operate on snapshots; terminal storage commits async.
 * The unexposed snapshot receipt prevents an edit from overwriting either a
 * controller's newer edit or an input already claimed by the native runner. */
export class TerminalOrcaQueue {
  private readonly snapshots = new WeakMap<AgentInputQueuedMessage, Submission>();
  constructor(private readonly host: {
    storage: TerminalTaskStorage;
    store: TerminalOrcaStore;
    assertCurrent(): void;
    mutate<T>(id: string, work: () => Promise<T>): Promise<T>;
    consuming(id: string, clientId: string): boolean;
    locked(id: string, clientId: string): boolean;
    normalize(id: string, input: unknown): Promise<UserMessage>;
    changed(id: string, rows: Submission[]): Promise<void>;
    reordered(id: string, clientIds: string[]): void;
    discard(clientId: string): void;
  }) {}

  async snapshot(id: string): Promise<AgentInputQueuedMessage[]> {
    const [row, pending] = await Promise.all([this.host.storage.get(id), this.host.storage.queued(id)]);
    this.host.assertCurrent();
    if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
    return Promise.all(pending.map(async receipt => {
      const origin = receipt.collaboration?.origin ?? receipt.orca?.origin ?? receipt.scheduler
        ?? (receipt.sender ? { kind: 'session' as const, senderSessionId: receipt.sender.sessionId, senderSessionTitle: receipt.sender.title, displayText: inputPlainText(receipt.message) } : undefined);
      const files: AgentInputSerializedFile[] = typeof receipt.message?.content === 'object' ? (await Promise.all(receipt.message.content.map(async (block, index) => {
        if (block.type !== 'image' && block.type !== 'file') return [];
        const name = path.basename(block.path), ext = path.extname(block.path).toLowerCase();
        return [{ id: `${receipt.requestId}-${index}`, name, path: block.path, ext, size: (await stat(block.path)).size,
          category: block.type === 'image' ? 'image' as const : 'file' as const,
          mimeType: block.mimeType ?? 'application/octet-stream',
          ...('managedUrl' in block && typeof block.managedUrl === 'string' ? { url: block.managedUrl } : {}) }];
      }))).flat() : [];
      const content = receipt.message ? persistedInput(terminalOrcaHistoryMessage(receipt.message, receipt.collaboration)) : '';
      const item: AgentInputQueuedMessage = { clientId: receipt.requestId, text: inputPlainText(receipt.message),
        persistedContent: content, model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'ask',
        workingDir: row.workDir, origin, ...(files.length ? { files } : {}),
        chatMessage: { clientId: receipt.requestId, role: 'user', content, createdAt: new Date(receipt.createdAt).toISOString() },
        createOpts: { agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId,
          effort: row.effort, permissionMode: row.permissionMode, fastMode: row.fastMode, orcaRole: row.orcaRole },
      };
      this.snapshots.set(item, receipt);
      return item;
    }));
  }

  private async commit(id: string, expected: Submission[], edits: Array<{ requestId: string; patch: QueuedSubmissionPatch }>) {
    if (expected.some(row => this.host.consuming(id, row.requestId) || this.host.locked(id, row.requestId))) return false;
    try {
      const changed = await this.host.storage.compareAndEditQueued(id, expected, edits, () => {
        this.host.assertCurrent();
        if (expected.some(row => this.host.consuming(id, row.requestId) || this.host.locked(id, row.requestId))) throw new Error('QUEUE_INPUT_CONSUMING');
      });
      if (!changed) return false;
      await this.host.changed(id, changed);
      for (const row of changed) if (row.status !== 'queued') this.host.discard(row.requestId);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'QUEUE_INPUT_CONSUMING') return false;
      throw error;
    }
  }

  remove(id: string, clientId: string, expected?: AgentInputQueuedMessage) {
    return this.host.mutate(id, async () => {
      const item = expected ?? (await this.snapshot(id)).find(item => item.clientId === clientId);
      const receipt = item && this.snapshots.get(item);
      if (!receipt || receipt.requestId !== clientId || receipt.sessionId !== id) return false;
      return this.commit(id, [receipt], [{ requestId: clientId, patch: { status: 'interrupted', error: 'INPUT_REMOVED' } }]);
    });
  }

  replace(id: string, clientId: string, next: AgentInputQueuedMessage, expected?: AgentInputQueuedMessage) {
    return this.host.mutate(id, async () => {
      const item = expected ?? (await this.snapshot(id)).find(item => item.clientId === clientId);
      const receipt = item && this.snapshots.get(item);
      if (!receipt || receipt.requestId !== clientId || receipt.sessionId !== id || next.clientId !== clientId) return false;
      const patch = await this.replacement(id, next);
      return this.commit(id, [receipt], [{ requestId: clientId, patch }]);
    });
  }

  private async replacement(id: string, next: AgentInputQueuedMessage): Promise<QueuedSubmissionPatch> {
    const collaboration = await captureTerminalOrcaInput(this.host.store, this.host.storage, id, next);
    const message = await this.host.normalize(id, { text: next.text, files: next.files, mentions: next.mentions });
    return { message, collaboration };
  }

  merge(id: string, clientIds: readonly string[], build: (items: readonly AgentInputQueuedMessage[]) => AgentInputQueuedMessage | null) {
    return this.host.mutate(id, async () => {
      if (clientIds.length < 2 || new Set(clientIds).size !== clientIds.length) return false;
      const queue = await this.snapshot(id), targets = queue.filter(item => clientIds.includes(item.clientId));
      if (targets.length !== clientIds.length) return false;
      const next = build(targets);
      if (!next || next.clientId !== targets[0]!.clientId) return false;
      const patch = await this.replacement(id, next);
      return this.commit(id, targets.map(item => this.snapshots.get(item)!), targets.map((item, index) => ({
        requestId: item.clientId, patch: index === 0 ? patch : { status: 'interrupted', error: 'INPUT_REMOVED' },
      })));
    });
  }

  move(id: string, clientId: string, position: number): Promise<number | null | 'locked'> {
    return this.host.mutate(id, async () => {
      const queue = await this.host.storage.queued(id), index = queue.findIndex(row => row.requestId === clientId);
      if (index < 0 || this.host.consuming(id, clientId)) return null;
      if (this.host.locked(id, clientId)) return 'locked';
      if (!Number.isInteger(position) || position < 0) throw new Error('INVALID_QUEUE_INDEX');
      const destination = Math.min(position, queue.length - 1);
      queue.splice(destination, 0, ...queue.splice(index, 1));
      const ids = queue.map(row => row.requestId);
      await this.host.storage.reorderQueued(id, ids, () => {
        this.host.assertCurrent();
        if (this.host.consuming(id, clientId)) throw new Error('QUEUE_INPUT_CONSUMING');
        if (this.host.locked(id, clientId)) throw new Error('QUEUE_INPUT_LOCKED');
      });
      this.host.reordered(id, ids);
      return destination;
    }).catch(error => {
      if (error instanceof Error && error.message === 'QUEUE_INPUT_CONSUMING') return null;
      if (error instanceof Error && error.message === 'QUEUE_INPUT_LOCKED') return 'locked' as const;
      throw error;
    });
  }
}
