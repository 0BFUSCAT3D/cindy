import path from 'node:path';
import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { MakerMemoryManager, MakerContactsManager, resolveMemoryScopeKey, memoryScopeDirName, type AgentKind, type Logger } from '@cindy/maker-core';
import { createCindyMemoryMcpServer } from '../../../packages/lizi-mcps/src/cindy_memoryMcpServer.js';
import { createCindyContactsMcpServer } from '../../../packages/lizi-mcps/src/cindy_contactsMcpServer.js';
import type { SessionSearchFn } from '../../../packages/lizi-mcps/src/types.js';
import { readPrivateFile, atomicPrivateWrite, privateDirectory } from './platform.js';

const preferences = z.object({ memory: z.boolean().default(true), contacts: z.boolean().default(false) }).strict();

/** Account-owned services. Every task owns its memory pool, while contacts share
 * one account database. Stopping a task cannot dispose another task's pool. */
export class TerminalKnowledge {
  readonly contacts: MakerContactsManager;
  readonly memory: MakerMemoryManager;
  readonly ready: Promise<void>;
  private value = preferences.parse({});
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private runtimes = new Set<MakerMemoryManager>();
  constructor(private readonly options: {
    root: string; logger: Logger; assertCurrent(): void; changed(collection: string): void;
    workingDirs(): Promise<string[]>; searchSessions?: SessionSearchFn;
    reviewOneShot?: ConstructorParameters<typeof MakerMemoryManager>[0]['reviewOneShot'];
  }) {
    this.contacts = new MakerContactsManager({ basePath: options.root, logger: options.logger, sqliteFactory: file => this.database(file) });
    this.memory = this.createMemory();
    this.ready = this.open();
  }
  private database(file: string) {
    this.guard();
    const db = new Database(file);
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
    return db;
  }
  private async open() {
    await privateDirectory(this.options.root);
    const raw = await readPrivateFile(path.join(this.options.root, 'knowledge-settings.json'));
    this.guard();
    if (raw) this.value = preferences.parse(JSON.parse(raw.toString()));
    if (!this.value.memory) await this.memory.disable();
  }
  guard() { if (this.closed) throw new Error('KNOWLEDGE_CLOSED'); this.options.assertCurrent(); }
  snapshot() { this.guard(); return { ...this.value }; }
  private createMemory() {
    return new MakerMemoryManager({
      basePath: this.options.root, resolveBasePath: () => { this.guard(); return this.options.root; },
      ownerScopeKey: () => { this.guard(); return this.options.root; },
      reloadEnabled: () => this.value.memory, initialEnabled: this.value.memory,
      sqliteFactory: file => this.database(file), agents: {}, logger: this.options.logger,
      reviewOneShot: this.options.reviewOneShot,
    });
  }
  async configure(patch: unknown, assertCurrent: () => void = () => {}) {
    await this.ready; const parsed = preferences.partial().parse(patch);
    const work = this.writes.then(async () => {
      this.guard(); assertCurrent();
      const next = { ...this.value, ...parsed };
      await atomicPrivateWrite(path.join(this.options.root, 'knowledge-settings.json'), JSON.stringify(next));
      this.guard(); assertCurrent(); this.value = next;
      for (const manager of [this.memory, ...this.runtimes]) {
        if (next.memory) await manager.enable({ skipAgentSync: true }); else await manager.disable();
      }
      this.options.changed('memory'); this.options.changed('contacts');
      return this.snapshot();
    });
    this.writes = work.catch(() => {}); return work;
  }
  async scopes(): Promise<Array<{ id: string; scope: string }>> {
    await this.ready; this.guard();
    const scopes = new Set<string>();
    for (const dir of new Set(await this.options.workingDirs())) scopes.add(await resolveMemoryScopeKey(dir));
    const base = path.join(this.options.root, 'maker-memory');
    const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = await open(path.join(base, entry.name, 'meta.json'), constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!file) continue;
      let value: unknown;
      try { const info = await file.stat(); if (!info.isFile() || info.size > 64 * 1024) throw new Error('INVALID_MEMORY_METADATA'); value = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
      const scope = value && typeof value === 'object' && 'absPath' in value ? value.absPath : undefined;
      if (typeof scope === 'string' && path.isAbsolute(scope) && memoryScopeDirName(scope) === entry.name) scopes.add(scope);
    }
    this.guard();
    return [...scopes].sort().map(scope => ({ id: createHash('sha256').update(scope).digest('hex'), scope }));
  }
  async createRuntime(input: { sessionId: string; workingDir: string; agentKind: AgentKind }, independent?: { memory: MakerMemoryManager; scopeKey: string; assertCurrent(): Promise<void> }) {
    await this.ready; this.guard();
    const scopeKey = independent?.scopeKey ?? await resolveMemoryScopeKey(input.workingDir); this.guard();
    const memory = independent?.memory ?? this.createMemory(); this.runtimes.add(memory);
    let closed = false;
    const guard = () => { this.guard(); if (closed) throw new Error('KNOWLEDGE_RUNTIME_CLOSED'); };
    const context = () => ({ ...input, memoryScopeKey: scopeKey });
    const withAccountDataAccess: import('../../../packages/lizi-mcps/src/account-data-access.js').AccountDataAccess = async (id, operation) => {
      guard(); if (id !== input.sessionId) throw new Error('TASK_SCOPE_MISMATCH');
      await independent?.assertCurrent();
      const value = await operation(async () => { guard(); await independent?.assertCurrent(); }); guard(); await independent?.assertCurrent(); return value;
    };
    return {
      memory, scopeKey, contactsEnabled: this.value.contacts,
      factories: {
        cindy_memory: () => createCindyMemoryMcpServer({ getManager: () => { guard(); return memory; }, workdir: input.workingDir, getSessionContext: context, withAccountDataAccess, searchSessions: this.options.searchSessions }),
        cindy_contacts: () => createCindyContactsMcpServer({ getManager: () => { guard(); return this.contacts; }, isEnabled: () => { guard(); return this.value.contacts; }, getSessionContext: context, withAccountDataAccess, onMutated: () => this.options.changed('contacts') }),
      },
      close: async () => { if (closed) return; closed = true; this.runtimes.delete(memory); if (!independent) memory.dispose(); },
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; await this.writes;
    for (const runtime of this.runtimes) runtime.dispose(); this.runtimes.clear();
    this.memory.dispose(); this.contacts.dispose();
  }
}
