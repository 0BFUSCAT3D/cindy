import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useAvailableAgents } from '@/hooks/useAvailableAgents';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { BotAutonomySettingsView } from '../../../shared/botAutonomy';
import type { BotMemoryDeleteInput, BotMemoryUpdateInput } from '../../../shared/botMemory';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotSkillSummary } from '../../../shared/botSkill';
import type { BotSettingsOp } from '../../../shared/botRemoteSettings';
import { createIpcError } from '../../../shared/ipc-errors';
import { normalizeDbProfile, type BotProfile, type BotProfileUpdatePatch } from './botStore';
import type { BotCapabilityEntry, BotCapabilityKind, BotSettingsTarget } from './botSettingsTarget';
import { invokeBotSettings, splitProfilePatch } from './remoteBotSettingsClient';
import { useRemoteBots } from './useRemoteBots';

export interface RemoteBotSettingsInput {
  deviceId: string;
  deviceName: string;
  botId: string;
  /** Operations the teammate's computer implements (`caps`). */
  ops: ReadonlySet<BotSettingsOp>;
  online(): boolean;
}

/** One teammate's profile as read from its computer; writes mirror the local store's optimistic rules. */
export function createRemoteProfileStore(deviceId: string, botId: string) {
  let profile: BotProfile | null = null;
  const listeners = new Set<() => void>();
  let writeGeneration = 0;
  let readGeneration = 0;
  let writing = 0;
  const emit = () => listeners.forEach((listener) => listener());
  const adopt = (raw: unknown): BotProfile => {
    const next = normalizeDbProfile((raw as { profile?: unknown } | null)?.profile);
    if (!next) throw createIpcError('INTERNAL', 'Invalid teammate profile');
    // Re-reads that change nothing keep the same object so the pages do not reconcile for nothing.
    if (profile && JSON.stringify(profile) === JSON.stringify(next)) return profile;
    profile = next;
    emit();
    return next;
  };
  return {
    get: () => profile,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async refresh() {
      const generation = ++readGeneration;
      const writes = writeGeneration;
      const raw = await invokeBotSettings(deviceId, 'profile.get', botId);
      // A write that started or finished meanwhile carries newer state than this read.
      if (generation !== readGeneration || writing > 0 || writes !== writeGeneration) return;
      adopt(raw);
    },
    async load() {
      const raw = await invokeBotSettings(deviceId, 'profile.get', botId);
      return adopt(raw);
    },
    async update(patch: BotProfileUpdatePatch): Promise<BotProfile> {
      const before = profile;
      if (!before) throw new Error('Bot not found');
      const { avatarUploadToken: _token, capabilityBaseline, ...profilePatch } = patch;
      const generation = ++writeGeneration;
      writing += 1;
      profile = { ...before, ...profilePatch, capabilities: { ...before.capabilities, ...profilePatch.capabilities } };
      emit();
      const body: Record<string, unknown> = {
        ...profilePatch,
        ...(capabilityBaseline ? { capabilityBaseline } : {}),
        ...(profilePatch.avatar !== undefined ? { expectedAvatar: before.avatar } : {}),
      };
      try {
        let raw: unknown;
        for (const part of splitProfilePatch(body)) raw = await invokeBotSettings(deviceId, 'profile.update', botId, { patch: part });
        const next = normalizeDbProfile((raw as { profile?: unknown } | null)?.profile);
        if (!next) throw createIpcError('INTERNAL', 'Invalid teammate profile');
        // A newer write on this profile is closer to what the person wants now.
        if (generation === writeGeneration) {
          profile = next;
          emit();
        }
        return next;
      } catch (error) {
        if (generation === writeGeneration) {
          profile = before;
          emit();
        }
        throw error;
      } finally {
        writing -= 1;
      }
    },
    /** Result of a host-side change (avatar, retry, lifecycle) that returns the new profile. */
    adopt,
  };
}
export type RemoteProfileStore = ReturnType<typeof createRemoteProfileStore>;

/** Gallery or uploaded art, normalised to a small JPEG so it fits the invoke input limit. */
async function toRemoteAvatar(base64: string): Promise<string> {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image unavailable');
  context.drawImage(image, 0, 0, 128, 128);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

const BASELINE_TOOLSETS = ['memory', 'xdt_helper', 'scheduler', 'lsp'];

/** Pages the host can serve, from the operations it implements. */
export function remoteBotSettingsPages(ops: ReadonlySet<BotSettingsOp>): Set<string> {
  const has = (...needed: BotSettingsOp[]) => needed.every((op) => ops.has(op));
  const pages = new Set<string>();
  if (has('profile.get', 'profile.update')) {
    pages.add('profile');
    pages.add('personality');
  }
  if (has('memory.list', 'memory.read', 'memory.update', 'memory.delete')) pages.add('memory');
  if (has('models.default', 'profile.update')) pages.add('model');
  if (has('capabilities.catalog')) pages.add('capabilities');
  if (has('history.search')) pages.add('history');
  return pages;
}

/**
 * The settings pages for a teammate on another computer. Reads and writes go to that computer through
 * `management:settings`; the pages themselves are the local components.
 */
export function createRemoteBotSettingsTarget(input: RemoteBotSettingsInput) {
  const { deviceId, botId } = input;
  const profiles = createRemoteProfileStore(deviceId, botId);
  const call = <T>(op: BotSettingsOp, args?: Record<string, unknown>) => invokeBotSettings<T>(deviceId, op, botId, args);

  let defaultChain: BotModelRoute[] = [];
  const chainListeners = new Set<() => void>();
  let chainKey = '[]';
  const loadDefaultChain = async () => {
    if (!input.ops.has('models.default')) return;
    const { modelChain } = await invokeBotSettings<{ modelChain: BotModelRoute[] }>(deviceId, 'models.default', null);
    const key = JSON.stringify(modelChain);
    if (key === chainKey) return;
    chainKey = key;
    defaultChain = modelChain;
    chainListeners.forEach((listener) => listener());
  };

  let autonomy: BotAutonomySettingsView | null = null;
  const autonomyListeners = new Set<() => void>();
  const loadAutonomy = async () => {
    const view = await invokeBotSettings<BotAutonomySettingsView>(deviceId, 'autonomy.get', null);
    autonomy = view;
    autonomyListeners.forEach((listener) => listener());
  };
  const applyAutonomy = (view: BotAutonomySettingsView) => {
    autonomy = view;
    autonomyListeners.forEach((listener) => listener());
  };

  const catalogWatchers = new Set<() => void>();

  const target: BotSettingsTarget = {
    kind: 'remote',
    deviceId,
    deviceName: input.deviceName,
    get online() {
      return input.online();
    },
    pages: remoteBotSettingsPages(input.ops),
    profile: {
      update: (_id, patch) => profiles.update(patch),
      async chooseAvatar(_id, avatarImageBase64) {
        // The native chooser reads files of the computer it runs on; here the picker hands over bytes.
        if (avatarImageBase64 === undefined) return null;
        const raw = await call('profile.chooseAvatar', { avatarImageBase64: await toRemoteAvatar(avatarImageBase64) });
        return profiles.adopt(raw);
      },
      async retryInvitation() {
        profiles.adopt(await call('profile.retryInvitation'));
      },
    },
    lifecycle: {
      async run(request) {
        const result = await call<Awaited<ReturnType<BotSettingsTarget['lifecycle']['run']>>>('lifecycle.run', {
          action: request.action,
          confirmName: request.confirmName,
          worktreeDisposition: request.worktreeDisposition,
          keepTaskHistory: request.keepTaskHistory,
        });
        if (result.status !== 'deleted') await profiles.refresh();
        return result;
      },
    },
    useDefaultModelChain() {
      useEffect(() => {
        void loadDefaultChain().catch(() => undefined);
      }, []);
      return useSyncExternalStore(
        (listener) => (chainListeners.add(listener), () => void chainListeners.delete(listener)),
        () => defaultChain,
      );
    },
    useHiddenVendors() {
      const { availableVendors, loaded } = useAvailableAgents(deviceId);
      return useMemo<MakerVendor[]>(
        () => (loaded ? (['cc', 'codex', 'pi'] as const).filter((item) => !availableVendors.has(item)) : []),
        [loaded, availableVendors],
      );
    },
    useRoster() {
      const bots = useRemoteBots();
      return useMemo(() => bots.filter((bot) => bot.deviceId === deviceId).map((bot) => ({ id: bot.id, name: bot.name })), [bots]);
    },
    memory: {
      list: (id, query) => invokeBotSettings(deviceId, 'memory.list', id, { query }),
      read: (id, filename) => invokeBotSettings(deviceId, 'memory.read', id, { filename }),
      update: (body) => {
        const { botId: id, ...rest } = body as BotMemoryUpdateInput;
        return invokeBotSettings(deviceId, 'memory.update', id, rest);
      },
      async delete(body) {
        const { botId: id, ...rest } = body as BotMemoryDeleteInput;
        await invokeBotSettings(deviceId, 'memory.delete', id, rest);
      },
    },
    history: { search: ({ botId: id, query, limit }) => invokeBotSettings<ConversationSearchResponse>(deviceId, 'history.search', id, { query, limit }) },
    capabilities: {
      async load(bot) {
        const result = await invokeBotSettings<{
          personal: BotSkillSummary[];
          entries: Partial<Record<BotCapabilityKind, Array<{ id: string; name: string; description?: string; available: boolean }>>>;
        }>(deviceId, 'capabilities.catalog', bot.id);
        const entries = (kind: BotCapabilityKind): BotCapabilityEntry[] =>
          (result.entries[kind] ?? []).map(({ id, name, description, available }) => ({ id, name, description, available }));
        return {
          skill: [
            ...result.personal.map((item) => ({ id: `personal:${item.slug}`, name: item.name, available: item.enabled !== false, personal: true })),
            ...entries('skill'),
          ],
          mcp: entries('mcp'),
          toolset: entries('toolset').filter((item) => !BASELINE_TOOLSETS.includes(item.id)),
        };
      },
      watch(_bot, refresh) {
        catalogWatchers.add(refresh);
        return () => void catalogWatchers.delete(refresh);
      },
    },
    autonomy: {
      useSettings() {
        useEffect(() => {
          void loadAutonomy().catch(() => undefined);
        }, []);
        return useSyncExternalStore(
          (listener) => (autonomyListeners.add(listener), () => void autonomyListeners.delete(listener)),
          () => autonomy,
        );
      },
      async setSchedulerBotId(id) {
        applyAutonomy(await invokeBotSettings<BotAutonomySettingsView>(deviceId, 'autonomy.set', null, { schedulerBotId: id }));
      },
      async reset() {
        applyAutonomy(await invokeBotSettings<BotAutonomySettingsView>(deviceId, 'autonomy.reset', null));
      },
    },
  };

  return {
    target,
    profiles,
    /** The teammate's computer reported a change: re-read what the open pages show. */
    changed() {
      void profiles.refresh().catch(() => undefined);
      if (autonomyListeners.size) void loadAutonomy().catch(() => undefined);
      if (chainListeners.size) void loadDefaultChain().catch(() => undefined);
      catalogWatchers.forEach((refresh) => refresh());
    },
  };
}
export type RemoteBotSettingsHandle = ReturnType<typeof createRemoteBotSettingsTarget>;
