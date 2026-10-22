import {
  BOT_SETTINGS_CAPABILITY_FIELDS,
  BOT_SETTINGS_PATCH_FIELDS,
  type BotSettingsOp,
} from '../../../shared/botRemoteSettings.js';
import type { BotAutonomySettingsView } from '../../../shared/botAutonomy.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import type { BotLifecycleActionRequest } from '../../../shared/botLifecycle.js';
import type { BotMemoryDeleteInput, BotMemoryUpdateInput } from '../../../shared/botMemory.js';
import type { BotSkillSummary } from '../../../shared/botSkill.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import type { BotSettingsCall, BotSettingsOpHandler } from './botRemoteSettingsHost.js';

type Kind = 'skill' | 'mcp' | 'toolset';
export interface BotCapabilityCatalogEntry {
  id: string;
  name: string;
  description: string;
  available: boolean;
  joined: boolean;
}

/** Services the local settings IPC already uses; injected so the operations stay free of main singletons. */
export interface BotSettingsOpsDeps {
  readProfile(botId: string): Promise<unknown>;
  updateProfile(input: Record<string, unknown>): Promise<unknown>;
  setAvatar(botId: string, avatarImageBase64: string): Promise<unknown>;
  retryInvitation(botId: string): Promise<unknown>;
  lifecycle(request: BotLifecycleActionRequest, guard: () => Promise<void>): Promise<unknown>;
  defaultModelChain(): Promise<BotModelRoute[]>;
  memory: {
    list(botId: string, query?: string): Promise<unknown>;
    read(botId: string, filename: string): Promise<unknown>;
    update(input: BotMemoryUpdateInput): Promise<unknown>;
    delete(input: BotMemoryDeleteInput): Promise<void>;
  };
  /** Canonical task of a visible teammate (null while it has none). */
  canonicalSessionId(botId: string): Promise<string | null>;
  capabilities(callerSessionId: string, kind: Kind): Promise<BotCapabilityCatalogEntry[]>;
  personalSkills(botId: string): Promise<BotSkillSummary[]>;
  autonomy: {
    get(): Promise<BotAutonomySettingsView>;
    set(schedulerBotId: string | null): Promise<BotAutonomySettingsView>;
    reset(): Promise<BotAutonomySettingsView>;
  };
  searchHistory(botId: string, query: string, limit: number): Promise<unknown>;
}

const fail = (message = 'Invalid settings arguments'): never => throwIpcError('INVALID_PARAMS', message);
const record = (value: unknown, name: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(`${name} must be an object`);
const text = (value: unknown, name: string, max: number, allowEmpty = false): string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) ? value : fail(`${name} is invalid`);
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[], name: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} has an unsupported field`);
};
const botOf = (call: BotSettingsCall): string => call.botId ?? fail('Teammate required');

/** Strips what the controller must not receive: Home path, runtime snapshots, last-message content and hidden lanes. */
export function projectBotSettingsProfile(raw: unknown): Record<string, unknown> {
  const { homeDir: _homeDir, lastMessagePreview: _preview, lastMessageAt: _at, lastMessageRole: _role, unreadCount: _unread, sessions, ...profile } =
    record(raw, 'profile') as Record<string, unknown> & { sessions?: unknown };
  return {
    ...profile,
    sessions: (Array.isArray(sessions) ? sessions : []).flatMap(item => {
      const session = item as Record<string, unknown>;
      // Group and IM lanes are not the teammate's own tasks and their records live in the group / IM.
      if (!session || typeof session.id !== 'string' || session.role === 'group' || session.role === 'channel') return [];
      return [{ id: session.id, title: session.title, kind: session.kind, updatedAt: session.updatedAt, status: session.status, role: session.role,
        ...(session.threadRoot ? { threadRoot: session.threadRoot } : {}) }];
    }),
  };
}

/** Whitelist of what an autosave may write; raising permissions stays in the confirmed generic form. */
export function readBotSettingsPatch(value: unknown): Record<string, unknown> {
  const patch = record(value, 'patch');
  keysWithin(patch, BOT_SETTINGS_PATCH_FIELDS, 'patch');
  if (patch.capabilities !== undefined) keysWithin(record(patch.capabilities, 'capabilities'), BOT_SETTINGS_CAPABILITY_FIELDS, 'capabilities');
  if (patch.capabilityBaseline !== undefined) record(patch.capabilityBaseline, 'capabilityBaseline');
  if (!Object.keys(patch).length) fail('patch is empty');
  return patch;
}

const ACTIONS = new Set(['resume', 'restart', 'delete']);
const KINDS: readonly Kind[] = ['skill', 'mcp', 'toolset'];

export function createBotRemoteSettingsOps(deps: BotSettingsOpsDeps): Partial<Record<BotSettingsOp, BotSettingsOpHandler>> {
  return {
    'profile.get': async call => ({ profile: projectBotSettingsProfile(await deps.readProfile(botOf(call))) }),
    'profile.update': async call => {
      const botId = botOf(call);
      const patch = readBotSettingsPatch(call.args.patch);
      return { profile: projectBotSettingsProfile(await deps.updateProfile({ id: botId, ...patch })) };
    },
    'profile.chooseAvatar': async call => ({
      profile: projectBotSettingsProfile(await deps.setAvatar(botOf(call), text(call.args.avatarImageBase64, 'avatarImageBase64', 80_000))),
    }),
    'profile.retryInvitation': async call => {
      await deps.retryInvitation(botOf(call));
      return { profile: projectBotSettingsProfile(await deps.readProfile(botOf(call))) };
    },
    'lifecycle.run': async call => {
      const botId = botOf(call);
      const action = text(call.args.action, 'action', 16);
      if (!ACTIONS.has(action)) fail('Unknown lifecycle action');
      const confirmName = call.args.confirmName === undefined ? undefined : text(call.args.confirmName, 'confirmName', 200);
      const worktreeDisposition = call.args.worktreeDisposition === 'retain' || call.args.worktreeDisposition === 'recycle' ? call.args.worktreeDisposition : undefined;
      return deps.lifecycle({ botId, action: action as BotLifecycleActionRequest['action'], confirmName, worktreeDisposition, keepTaskHistory: call.args.keepTaskHistory === true },
        async () => call.assertCurrent());
    },
    'models.default': async () => ({ modelChain: await deps.defaultModelChain() }),
    'memory.list': async call => deps.memory.list(botOf(call), call.args.query === undefined ? '' : text(call.args.query, 'query', 200, true)),
    'memory.read': async call => deps.memory.read(botOf(call), text(call.args.filename, 'filename', 256)),
    'memory.update': async call => deps.memory.update({
      botId: botOf(call),
      filename: text(call.args.filename, 'filename', 256),
      title: text(call.args.title, 'title', 1_000, true),
      body: text(call.args.body, 'body', 40_000, true),
      expectedUpdatedAt: text(call.args.expectedUpdatedAt, 'expectedUpdatedAt', 64),
    }),
    'memory.delete': async call => {
      await deps.memory.delete({ botId: botOf(call), filename: text(call.args.filename, 'filename', 256), expectedUpdatedAt: text(call.args.expectedUpdatedAt, 'expectedUpdatedAt', 64) });
      return null;
    },
    'capabilities.catalog': async call => {
      const botId = botOf(call);
      const callerSessionId = await deps.canonicalSessionId(botId);
      call.assertCurrent();
      if (!callerSessionId) throwIpcError('PRECONDITION_FAILED', 'Missing canonical task');
      const personal = await deps.personalSkills(botId);
      const entries = await Promise.all(KINDS.map(async kind => [kind, await deps.capabilities(callerSessionId, kind)] as const));
      return { personal, entries: Object.fromEntries(entries) };
    },
    'autonomy.get': async () => deps.autonomy.get(),
    'autonomy.set': async call => {
      const value = call.args.schedulerBotId;
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128)) fail('schedulerBotId must be a teammate id or null');
      return deps.autonomy.set(value as string | null);
    },
    'autonomy.reset': async () => deps.autonomy.reset(),
    'history.search': async call => {
      const limit = typeof call.args.limit === 'number' && Number.isFinite(call.args.limit) ? Math.max(1, Math.min(50, Math.floor(call.args.limit))) : 20;
      return deps.searchHistory(botOf(call), text(call.args.query, 'query', 500), limit);
    },
  };
}
