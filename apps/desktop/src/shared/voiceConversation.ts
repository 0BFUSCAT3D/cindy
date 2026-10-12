import type { AudioTrace, ConversationInputEvent } from '@cindy/voice-input-core';
import type { AgentKind } from '@cindy/model-providers';

/** Local Desktop voice UI contract. No credentials, raw paths or remote invoke access. */
export type SpeechProtocol = 'openai' | 'elevenlabs' | 'minimax';
// Missing provider/runtime is the original Cindy AI selection, never another connection.
export type VoiceConversationSelection = {
  providerId?: string;
  agent?: AgentKind;
  modelId: string;
  voice: string;
  /** Explicit user choice for a custom speech endpoint; absent follows a known adapter. */
  protocol?: SpeechProtocol;
};
export type VoiceConversationModel = {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  agent?: AgentKind;
  protocol?: SpeechProtocol;
  defaultVoice?: string;
};
export type VoiceConversationPreference = {
  selection: VoiceConversationSelection | null;
  customized: boolean;
};
export function voiceModelKey(model: {
  providerId?: string;
  agent?: AgentKind;
  modelId?: string;
  id?: string;
}): string {
  return JSON.stringify([model.providerId ?? 'xd', model.agent ?? '', model.modelId ?? model.id]);
}
export type VoiceConversationEvent = {
  callId: string;
  event: ConversationInputEvent | { type: 'ended' };
};
export type VoiceConversationStart = VoiceConversationSelection & {
  callId: string;
  botId: string;
  sessionId: string;
};
export interface VoiceConversationApi {
  models(): Promise<VoiceConversationModel[]>;
  preference(botId: string): Promise<VoiceConversationPreference>;
  setPreference(
    botId: string,
    selection: VoiceConversationSelection | null,
  ): Promise<VoiceConversationPreference>;
  start(input: VoiceConversationStart): Promise<{ callId: string }>;
  audio(input: { callId: string; pcm: ArrayBuffer; trace?: AudioTrace }): void;
  finishUtterance(callId: string): Promise<void>;
  end(callId: string): Promise<void>;
  speak(input: {
    callId: string;
    requestId: string;
    text: string;
  }): Promise<{ sampleRate: number }>;
  readSpeech(callId: string, requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }>;
  interrupt(callId: string): Promise<void>;
  onEvent(callback: (event: VoiceConversationEvent) => void): () => void;
}

export function normalizeVoiceConversationSelection(
  value: unknown,
): VoiceConversationSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { modelId, voice, providerId, agent, protocol } =
    value as Partial<VoiceConversationSelection>;
  if (
    typeof modelId !== 'string' ||
    !modelId.trim() ||
    modelId.length > 256 ||
    typeof voice !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(voice) ||
    (providerId !== undefined &&
      (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256)) ||
    (protocol !== undefined && !['openai', 'elevenlabs', 'minimax'].includes(protocol)) ||
    ((providerId === undefined || providerId === 'xd') &&
      protocol !== undefined &&
      protocol !== 'openai') ||
    (agent !== undefined && !['claude-code', 'codex', 'pi'].includes(agent)) ||
    (providerId !== undefined && providerId !== 'xd' && !agent) ||
    ((providerId === undefined || providerId === 'xd') && agent !== undefined)
  )
    return undefined;
  return {
    modelId: modelId.trim(),
    voice,
    ...(providerId ? { providerId } : {}),
    ...(agent ? { agent } : {}),
    ...(protocol ? { protocol } : {}),
  };
}

export function normalizeVoiceConversationPreferences(
  value: unknown,
): Record<string, VoiceConversationSelection | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]) => {
      const selection = raw === null ? null : normalizeVoiceConversationSelection(raw);
      return id.trim() && id.length <= 256 && selection !== undefined ? [[id, selection]] : [];
    }),
  );
}
