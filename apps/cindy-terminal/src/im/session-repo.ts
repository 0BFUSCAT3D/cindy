import { createHash, randomUUID } from 'node:crypto';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import type { ImSessionRepo, ImSessionRow } from '@cindy/im-runtime/sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '@cindy/im-runtime/types';
import { buildImDefaultRouteRecord } from '@cindy/im-runtime/channelDefaultRoute';
import type { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import type { TerminalTaskStorage, TerminalTaskMeta, NewTerminalTaskMeta } from '../tasks/storage.js';
import type { TerminalImBindings } from './bindings.js';

export interface TerminalImRepositoryHost {
  ready: Promise<void>;
  storage: TerminalTaskStorage;
  bindings: TerminalImBindings;
  defaults: ReturnType<typeof createImSessionDefaults>;
  assertCurrent(): void;
  admit(row: ImSessionRow, title: string): Promise<NewTerminalTaskMeta>;
  changed(row: TerminalTaskMeta, kind: 'created' | 'patched'): void;
  warn(message: string): void;
}

/** Channel identities share the terminal's ordinary task storage and runtime.
 * Read-only configuration lookup never resurrects tasks. Incoming messages do;
 * Telegram /new rotates a distinct task with a recoverable takeover commit. */
export function createTerminalImSessionRepo(
  host: TerminalImRepositoryHost,
  config: ImOrchestratorConfig,
  ns: ImSessionNamespace,
  options: { projectSwitching?: boolean } = {},
): ImSessionRepo {
  const locks = new Map<string, Promise<unknown>>();
  const preparedAccounts = new WeakMap<ImSessionRow, () => void>();
  const sessionIdFor: ImSessionRepo['sessionIdFor'] = (bot, user, scope) => {
    const id = ns.sessionIdFor(bot, user, scope);
    return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : `${ns.source}_${createHash('sha256').update(id).digest('hex')}`;
  };
  function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (locks.get(id) ?? Promise.resolve()).then(action);
    const settled = result.then(() => {}, () => {});
    locks.set(id, settled);
    void settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
    return result;
  }
  async function ready() { await host.ready; host.assertCurrent(); }
  async function select(bot: string, user: string, scope?: string) {
    if (ns.createTaskOnNew) {
      const rows = (await host.storage.list()).filter(row => row.source === ns.source && row.imBotContextId === bot && row.imUserId === user && (row.imScopeKey ?? '') === (scope ?? ''));
      rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      if (rows[0]) return rows[0];
    }
    return host.storage.get(sessionIdFor(bot, user, scope));
  }
  function workspace(row: TerminalTaskMeta, bot?: string) {
    if (bot && options.projectSwitching && ns.workspaceKind === 'dialogue') return row.workDir === ns.ensureWorkingDir(bot) ? 'dialogue' as const : 'project' as const;
    return row.workspaceKind ?? ns.workspaceKind ?? null;
  }
  function project(row: TerminalTaskMeta, bot?: string): ImSessionRow {
    return { id: row.id, agentKind: row.agentKind, workingDir: row.workDir, model: row.model, effort: row.effort ?? 'high', permissionMode: permissionModeOrAsk(row.permissionMode), fastMode: row.fastMode ?? false, sdkSessionId: row.sdkSessionId ?? null, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, workspaceKind: workspace(row, bot), remoteHostId: null };
  }
  function markers(bot: string, user: string, scope?: string) {
    return { source: ns.source, imBotContextId: bot, imUserId: user, imScopeKey: scope ?? '' };
  }
  async function admit(row: ImSessionRow, bot: string, user: string, scope?: string) {
    const admitted = await host.admit(row, ns.defaultTitle(user));
    host.assertCurrent();
    const route = { agentKind: admitted.agentKind, model: admitted.model, effort: admitted.effort ?? row.effort, providerId: admitted.providerId ?? null, agentDeviceId: admitted.agentDeviceId ?? null };
    return { ...admitted, ...markers(bot, user, scope), workspaceKind: row.workspaceKind ?? ns.workspaceKind ?? 'project', userSendAt: Date.now(), imDefaultRoute: row.defaultRouteFingerprint ? buildImDefaultRouteRecord(row.defaultRouteFingerprint, route) : null } satisfies NewTerminalTaskMeta;
  }
  async function revive(row: TerminalTaskMeta, bot: string) {
    const kind = workspace(row, bot);
    if (row.deleted || row.archived || kind !== (row.workspaceKind ?? null)) {
      host.assertCurrent();
      row = await host.storage.update(row.id, { deleted: false, archived: false, ...(kind ? { workspaceKind: kind } : {}), ...(row.deleted || row.archived ? { userSendAt: Date.now() } : {}) });
      host.assertCurrent(); host.changed(row, 'created');
    }
    return project(row, bot);
  }
  const repo: ImSessionRepo = {
    sessionIdFor,
    getDefaultEffortFor: (model, agent = config.agentKind) => host.defaults.getImDefaultEffortFor(agent, model, config.effortOverrides),
    async peekSession(bot, user, scope) { await ready(); const row = await select(bot, user, scope); host.assertCurrent(); return row ? project(row, bot) : null; },
    async peekSessionById(id) { await ready(); const row = await host.storage.get(id); host.assertCurrent(); return row?.workDir ? project(row) : null; },
    async findActiveSession(bot, user, scope) {
      await ready();
      return locked(sessionIdFor(bot, user, scope), async () => { host.assertCurrent(); const row = await select(bot, user, scope); return row ? revive(row, bot) : null; });
    },
    async prepareNewSession(bot, user, scope, providers) {
      await ready();
      const defaults = await host.defaults.resolveImSessionDefaults(config, providers, ns.source);
      host.assertCurrent();
      const { fingerprint, ...route } = defaults;
      const row: ImSessionRow = { ...route, id: sessionIdFor(bot, user, scope), workingDir: ns.ensureWorkingDir(bot), permissionMode: ns.permissionModeFor?.(user) ?? route.permissionMode, sdkSessionId: null, remoteHostId: null, defaultRouteFingerprint: fingerprint, workspaceKind: ns.workspaceKind ?? 'project' };
      preparedAccounts.set(row, () => host.assertCurrent());
      return row;
    },
    async createSession(bot, user, scope, prepared) {
      await ready();
      const defaults = prepared ?? await repo.prepareNewSession(bot, user, scope);
      const assertCurrent = preparedAccounts.get(defaults) ?? (() => host.assertCurrent());
      return locked(sessionIdFor(bot, user, scope), async () => {
        assertCurrent();
        const prior = await select(bot, user, scope);
        if (prior) return revive(prior, bot);
        const metadata = await admit(defaults, bot, user, scope);
        assertCurrent();
        let row = await host.storage.create(metadata);
        assertCurrent(); host.changed(row, 'created');
        if (ns.resolveSessionTitle) {
          try {
            const title = await ns.resolveSessionTitle(user, scope);
            assertCurrent();
            const current = await host.storage.get(row.id);
            if (title && current?.title === ns.defaultTitle(user)) { row = await host.storage.update(row.id, { title }); assertCurrent(); host.changed(row, 'patched'); }
          } catch { host.warn('Channel task title could not be resolved'); }
        }
        return project(row, bot);
      });
    },
    async createFreshSession(bot, user, scope, prepared, detachBinding) {
      if (!ns.createTaskOnNew) throw new Error('CHANNEL_TASK_ROTATION_NOT_SUPPORTED');
      await ready();
      const assertCurrent = prepared && preparedAccounts.get(prepared) || (() => host.assertCurrent());
      return locked(sessionIdFor(bot, user, scope), async () => {
        assertCurrent();
        const previous = await select(bot, user, scope);
        const defaults = prepared ?? await repo.prepareNewSession(bot, user, scope);
        const row: ImSessionRow = { ...defaults, id: randomUUID(), workingDir: previous?.workDir ?? defaults.workingDir, workspaceKind: previous ? workspace(previous, bot) : defaults.workspaceKind, sdkSessionId: null };
        const metadata = await admit(row, bot, user, scope);
        assertCurrent();
        const current = await host.bindings.commitTaskRotation(detachBinding ?? null, bindings => host.storage.rotateChannelTask(metadata, previous?.id ?? null, bindings, assertCurrent));
        assertCurrent(); host.changed(current, 'created');
        if (previous && !previous.deleted) host.changed((await host.storage.get(previous.id))!, 'patched');
        return { current: project(current, bot), previous: previous ? project(previous, bot) : null };
      });
    },
  };
  return repo;
}
