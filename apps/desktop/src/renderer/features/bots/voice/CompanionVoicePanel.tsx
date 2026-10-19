import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import type { ChatMessage } from '@/lib/makerChatStore';
import { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import { VoiceConversationController } from './VoiceConversationController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { resolveVoiceConfiguration } from './voiceConfiguration';
import { CompanionVoiceToolbar } from './CompanionVoiceToolbar';

type Props = {
  bot: BotChatIdentity;
  sessionId: string;
  messages: readonly ChatMessage[];
  blocked: boolean;
  taskBusy: boolean;
  onClose(): void;
  onConfigure(): void;
  onSend(text: string, onCreated: (id: string) => void, isCurrent: () => boolean): Promise<boolean>;
};

export function CompanionVoicePanel(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [loading, setLoading] = useState(true);
  const [configurationError, setConfigurationError] = useState(false);
  const launchVersion = useRef(0);
  const controller = useMemo(
    () =>
      new VoiceConversationController({
        api: window.electronAPI.voiceConversation,
        botId: props.bot.id,
        sessionId: props.sessionId,
        isTaskBusy: () => latest.current.taskBusy,
        onAutoEnd: () => latest.current.onClose(),
        send: (...args) => latest.current.onSend(...args),
        microphone: (onInterrupted, onStateChange) =>
          new WebMicAudioEngine({
            workletUrl: getVoiceInputWorkletUrl(),
            deviceId: getVoiceInputSettings().microphoneDeviceId ?? undefined,
            chunkMs: 40,
            latencyMs: 10,
            keepAlive: false,
            audioProcessing: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: false,
            },
            onInterrupted,
            onStateChange,
          }),
        player: (onLevel) => new PcmSpeechPlayer(onLevel),
      }),
    [props.bot.id, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const start = useCallback(async () => {
    const version = ++launchVersion.current;
    setLoading(true);
    setConfigurationError(false);
    try {
      const [models, preference] = await Promise.all([
        window.electronAPI.voiceConversation.models(),
        window.electronAPI.voiceConversation.preference(props.bot.id),
      ]);
      if (version !== launchVersion.current || latest.current.blocked) return;
      const { selection, protocol } = resolveVoiceConfiguration(models, preference.selection);
      if (!selection || !protocol) {
        latest.current.onConfigure();
        return;
      }
      controller.setBlocked(false);
      await controller.start(selection, preference.sentencePlayback ?? true);
      if (version === launchVersion.current && !latest.current.blocked) controller.retryUnsent();
    } catch {
      if (version === launchVersion.current) setConfigurationError(true);
    } finally {
      if (version === launchVersion.current) setLoading(false);
    }
  }, [controller, props.bot.id]);

  useEffect(() => {
    titleRef.current?.focus();
    void start();
    return () => {
      ++launchVersion.current;
      controller.end();
    };
  }, [controller, start]);
  useEffect(() => {
    controller.setBlocked(props.blocked);
    if (props.blocked) {
      ++launchVersion.current;
      setLoading(false);
    }
  }, [controller, props.blocked]);
  useEffect(() => controller.updateMessages(props.messages), [controller, props.messages]);
  useEffect(() => controller.refreshActivity(), [controller, props.taskBusy]);
  useEffect(() => {
    const initialOwner = getDataOwnerGeneration();
    const owner = `${initialOwner.dataOwnerId}:${initialOwner.generation}`;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      if (next.ownerBoundaryPending || `${next.dataOwnerId}:${next.ownerGeneration}` !== owner) {
        ++launchVersion.current;
        controller.end();
        latest.current.onClose();
      }
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() => {
      ++launchVersion.current;
      setLoading(false);
      controller.setBlocked(true);
    });
    return () => {
      removeAuth();
      removePower();
    };
  }, [controller]);
  return (
    <CompanionVoiceToolbar
      bot={props.bot}
      state={state}
      loading={loading}
      blocked={props.blocked}
      configurationError={configurationError}
      titleRef={titleRef}
      onResume={() => void start()}
      onMute={() => void controller.toggleMute()}
      onInterrupt={() => controller.interrupt()}
      onSend={() => (state.transcript ? controller.finishUtterance() : controller.retryUnsent())}
      onCancelExit={() => {
        controller.cancelExit();
        titleRef.current?.focus();
      }}
      onClose={props.onClose}
      onConfigure={props.onConfigure}
    />
  );
}
