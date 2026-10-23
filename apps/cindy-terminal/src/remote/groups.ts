import path from 'node:path';
import { createProviderGroupDirectory, type ProviderGroupDirectoryDeps } from '@cindy/remote-agent/groups/directory';
import { createProviderGroupRouter } from '@cindy/remote-agent/groups/router';
import { createProviderGroupExternalLoad } from '@cindy/remote-agent/groups/externalLoad';
import { createProviderGroupRemoteClient } from '@cindy/remote-agent/groups/remoteClient';
import { handleProviderGroupRemote, decorateProviderListWithGroups } from '@cindy/remote-agent/groups/remoteHandler';
import { normalizeProviderGroupConfig, type ProviderGroupConfig } from '@cindy/remote-agent/shared/providerGroup';
import type { ProviderGroupPersistedCooling } from '@cindy/remote-agent/groups/cooling';
import type { ProviderGroupBinding } from '@cindy/remote-agent/groups/bindings';
import type { DeviceAgentServiceDeps } from '@cindy/remote-agent';
import type { ProviderView } from '@cindy/model-providers';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { TerminalRemoteContext } from './types.js';

export interface TerminalProviderGroupOptions extends Omit<ProviderGroupDirectoryDeps, 'now'> {
  profileDir: string;
  getOwnerScope(): string | null;
  invoke: DeviceAgentServiceDeps['remoteInvoke'];
  isRemoteAllowed(providerId: string): boolean;
  listBindings(): Record<string, ProviderGroupBinding>;
  isTurnRunning(sessionId: string): boolean;
  sessionGroup(sessionId: string): Promise<{ groupDeviceId: string | null; providerId: string } | null>;
}

/** Existing directory, quota, scheduling, lease and read/pick protocol. The
 * selected member owns execution; this service never runs a substitute agent. */
export class TerminalProviderGroups {
  private groups: Record<string, ProviderGroupConfig> = {};
  private cooling: ProviderGroupPersistedCooling = {};
  private usage: Record<string, unknown> = {};
  private readonly owner: string | null;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly file: string;
  readonly directory;
  router!: ReturnType<typeof createProviderGroupRouter>;
  readonly externalLoad;
  readonly remote;

  constructor(private readonly options: TerminalProviderGroupOptions) {
    this.owner = options.getOwnerScope(); this.file = path.join(options.profileDir, 'provider-groups.json');
    this.directory = createProviderGroupDirectory({ ...options, now: Date.now });
    this.externalLoad = createProviderGroupExternalLoad({ now: Date.now });
    this.ready = this.load().then(() => {
      this.assertCurrent();
      this.router = createProviderGroupRouter({
      directory: this.directory, readGroup: id => this.read(id),
      listBindings: options.listBindings, isTurnRunning: options.isTurnRunning,
      externalRunning: (providerId, memberKey) => this.externalLoad.running(providerId, memberKey),
      coolingStore: { read: () => this.cooling, write: value => { this.cooling = value; void this.persist().catch(() => undefined); } },
      now: Date.now, random: Math.random,
      });
    });
    this.remote = createProviderGroupRemoteClient(options.invoke);
  }
  private assertCurrent() {
    if (this.closed || this.options.getOwnerScope() !== this.owner) throw new Error('OWNER_CHANGED');
  }
  private async load() {
    await privateDirectory(this.options.profileDir);
    const raw = await readPrivateFile(this.file); if (!raw) return;
    const state = JSON.parse(raw.toString()) as { version?: unknown; groups?: Record<string, unknown>; cooling?: ProviderGroupPersistedCooling; usage?: Record<string, unknown> };
    if (state.version !== 1 || !state.groups || typeof state.groups !== 'object' || Object.keys(state.groups).length > 1024) throw new Error('INVALID_PROVIDER_GROUPS');
    for (const [id, value] of Object.entries(state.groups)) {
      const config = normalizeProviderGroupConfig(value, id);
      if (!config) throw new Error('INVALID_PROVIDER_GROUP');
      this.groups[id] = config;
    }
    if (state.cooling && typeof state.cooling === 'object') this.cooling = state.cooling;
    if (state.usage && typeof state.usage === 'object') this.usage = state.usage;
  }
  private persist() {
    const job = this.writes.then(async () => { await this.ready; this.assertCurrent(); await atomicPrivateWrite(this.file, JSON.stringify({ version: 1, groups: this.groups, cooling: this.cooling, usage: this.usage })); });
    this.writes = job.catch(() => undefined); return job;
  }
  read(id: string): ProviderGroupConfig | null { return this.groups[id] ? structuredClone(this.groups[id]) : null; }
  async list(): Promise<Record<string, ProviderGroupConfig>> { await this.ready; this.assertCurrent(); return structuredClone(this.groups); }
  async candidates(id: string) { await this.ready; this.assertCurrent(); return this.directory.listCandidates(id, this.read(id)); }
  async save(id: string, value: unknown, guard: () => void) {
    const normalized = normalizeProviderGroupConfig(value, id);
    if (!normalized) throw new Error('INVALID_PROVIDER_GROUP');
    const job = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      if (!(await this.options.listLocalProviders()).some(provider => provider.id === id)) throw new Error('INVALID_PROVIDER_GROUP');
      this.assertCurrent(); guard();
      if (!this.groups[id] && Object.keys(this.groups).length >= 1024) throw new Error('PROVIDER_GROUP_LIMIT');
      const groups = { ...this.groups, [id]: normalized };
      await atomicPrivateWrite(this.file, JSON.stringify({ version: 1, groups, cooling: this.cooling, usage: this.usage }));
      this.assertCurrent(); guard(); this.groups = groups; this.directory.invalidate();
    });
    this.writes = job.catch(() => undefined); await job;
  }
  async remove(id: string, guard: () => void) {
    const job = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      const { [id]: _, ...groups } = this.groups;
      await atomicPrivateWrite(this.file, JSON.stringify({ version: 1, groups, cooling: this.cooling, usage: this.usage }));
      this.assertCurrent(); guard(); this.groups = groups; this.directory.invalidate();
    });
    this.writes = job.catch(() => undefined); await job;
  }
  async decorate(providers: ProviderView[]) { await this.ready; this.assertCurrent(); return decorateProviderListWithGroups({ providers }, id => this.read(id)); }
  async request(raw: unknown, context: TerminalRemoteContext): Promise<unknown> {
    await this.ready; this.assertCurrent(); context.assertCurrent();
    if (context.source.kind !== 'owner') throw new Error('OWNER_REQUIRED');
    const result = await handleProviderGroupRemote({
      scope: () => ({ router: this.router, externalLoad: this.externalLoad, isCurrent: () => { try { this.assertCurrent(); context.assertCurrent(); return true; } catch { return false; } } }),
      readGroup: id => this.read(id), isRemoteAllowed: this.options.isRemoteAllowed, now: Date.now,
      sessionGroup: this.options.sessionGroup,
      replaceReportedUsage: (controller, sinceDay, rows) => {
        this.assertCurrent(); context.assertCurrent();
        this.usage[controller] = { sinceDay, rows }; return this.persist();
      },
    }, context.controllerDeviceId, raw);
    this.assertCurrent(); context.assertCurrent(); return result;
  }
  async close() { this.closed = true; this.directory.invalidate(); await this.writes; }
}
