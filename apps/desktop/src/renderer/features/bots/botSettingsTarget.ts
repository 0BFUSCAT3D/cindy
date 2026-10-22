import { createContext, useContext } from 'react';

import type { MakerVendor } from '@/lib/ccAgent.types';
import type { BotAutonomySettingsView } from '../../../shared/botAutonomy';
import type { BotLifecycleActionRequest, BotLifecycleActionResult } from '../../../shared/botLifecycle';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotSkillSummary } from '../../../shared/botSkill';
import type { BotProfile, BotProfileUpdatePatch } from './botStore';

export type BotCapabilityKind = 'skill' | 'mcp' | 'toolset';
export type BotCapabilityEntry = {
  id: string;
  name: string;
  description?: string;
  available: boolean;
  personal?: boolean;
};

type Bots = NonNullable<Window['electronAPI']['localDb']>['bots'];

/**
 * The computer a teammate's settings pages read from and write to. The pages are the same components for
 * every teammate; a target supplies the calls they make. The local target wraps this computer's IPC; the
 * remote one reaches the teammate's own computer through `management:settings`
 * (`shared/botRemoteSettings.ts`), where the same services run.
 */
export interface BotSettingsTarget {
  kind: 'local' | 'remote';
  /** Device-link id of the teammate's computer (remote only). */
  deviceId?: string;
  deviceName?: string;
  /** False while the computer cannot be reached: pages keep their content and writes are refused. */
  online: boolean;
  /** Pages whose host operations exist; the local target supports all of them. */
  pages: ReadonlySet<string>;
  profile: {
    update(botId: string, patch: BotProfileUpdatePatch): Promise<BotProfile>;
    /** Gallery / uploaded image bytes; omitted bytes open the native chooser (local only). */
    chooseAvatar(botId: string, avatarImageBase64?: string): Promise<BotProfile | null>;
    retryInvitation(botId: string): Promise<void>;
  };
  lifecycle: { run(request: BotLifecycleActionRequest): Promise<BotLifecycleActionResult> };
  /** Model defaults and engines are those of the teammate's computer. */
  useDefaultModelChain(): BotModelRoute[];
  useHiddenVendors(): MakerVendor[];
  /** Teammates on the same computer: name uniqueness and the follow-up holder's name. */
  useRoster(): ReadonlyArray<{ id: string; name: string; status?: string }>;
  memory: Bots['memory'];
  history: { search(body: { botId: string; query: string; limit: number }): Promise<ConversationSearchResponse> };
  capabilities: {
    load(bot: BotProfile, modelChain: BotModelRoute[]): Promise<Partial<Record<BotCapabilityKind, BotCapabilityEntry[]>>>;
    /** Calls `refresh` when the catalog may have changed (runtime, MCP or profile changes). */
    watch(bot: BotProfile, refresh: () => void): () => void;
  };
  autonomy: {
    useSettings(): BotAutonomySettingsView | null;
    setSchedulerBotId(botId: string | null): Promise<void>;
    reset(): Promise<void>;
  };
}

export const BotSettingsTargetContext = createContext<BotSettingsTarget | null>(null);
/** `null` = this computer; consumers fall back to `localBotSettingsTarget`. */
export const useOptionalBotSettingsTarget = () => useContext(BotSettingsTargetContext);

export type { BotSkillSummary };
