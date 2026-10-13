import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AudioLines, Mic, MicOff, PhoneOff, Send, Settings2, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import type { ChatMessage } from '@/lib/makerChatStore';
import { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import { BotAvatar } from '../BotAvatar';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import { VoiceConversationController } from './VoiceConversationController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { resolveVoiceConfiguration } from './voiceConfiguration';
import './voiceConversation.css';

type Props = {
  bot: BotChatIdentity;
  sessionId: string;
  messages: readonly ChatMessage[];
  blocked: boolean;
  onClose(): void;
  onConfigure(): void;
  onSend(text: string, onCreated: (id: string) => void, isCurrent: () => boolean): Promise<boolean>;
};

export function CompanionVoicePanel(props: Props) {
  const { t } = useTranslation();
  const labelId = useId();
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
        send: (...args) => latest.current.onSend(...args),
        microphone: (onInterrupted) =>
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
          }),
        player: (onLevel) => new PcmSpeechPlayer(onLevel),
      }),
    [props.bot.id, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const active = ['connecting', 'listening', 'thinking', 'preparing', 'speaking'].includes(
    state.phase,
  );
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
      await controller.start(selection);
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
  const status = props.blocked ? 'confirmation' : loading ? 'connecting' : state.phase;
  return (
    <section
      className="companion-voice-panel flex max-h-[min(36rem,65vh)] w-full flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
      aria-labelledby={labelId}
    >
      <div className="flex shrink-0 items-center gap-2">
        <AudioLines size={16} aria-hidden="true" />
        <h2 ref={titleRef} tabIndex={-1} id={labelId} className="text-13 font-medium outline-none">
          {t('bots.voiceMode.title')}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto w-8 px-0"
          aria-label={t('bots.voiceMode.openSettings')}
          title={t('bots.voiceMode.openSettings')}
          onClick={props.onConfigure}
        >
          <Settings2 size={16} />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="w-8 px-0"
          aria-label={t('bots.voiceMode.close')}
          onClick={props.onClose}
        >
          <X size={16} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div
          className={
            active
              ? 'flex flex-col items-center gap-3 py-5'
              : 'flex items-center justify-center gap-4 py-3'
          }
        >
          <div className="flex items-center gap-5">
            <BotAvatar bot={props.bot} size="xl" />
            <div
              className="companion-voice-meter flex h-10 items-center gap-1"
              aria-hidden="true"
              data-active={active}
            >
              {[0.4, 0.7, 1, 0.65, 0.9, 0.5, 0.75].map((weight, index) => (
                <span
                  key={index}
                  className="h-8 w-1 rounded-full bg-[var(--text-secondary)]"
                  style={{ transform: `scaleY(${0.12 + state.level * weight * 0.88})` }}
                />
              ))}
            </div>
          </div>
          <div className="text-center">
            <p className="text-15 font-medium">{props.bot.name}</p>
            <p
              className="mt-1 text-13 text-[var(--text-secondary)]"
              role="status"
              aria-live="polite"
            >
              {t(`bots.voiceMode.status.${status}`)}
            </p>
          </div>
        </div>

        {state.transcript ? (
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-center text-13">
            {state.transcript}
          </p>
        ) : null}
        {state.unsent ? (
          <div className="my-3 rounded-xl border border-[var(--border-default)] p-3">
            <p className="mb-1 text-12 text-[var(--text-secondary)]">
              {t('bots.voiceMode.unsent')}
            </p>
            <p className="max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words text-13">
              {state.unsent}
            </p>
          </div>
        ) : null}
        {state.error ? (
          <p role="alert" className="mb-3 text-13 text-[var(--error-fg)]">
            {t(`bots.voiceMode.errors.${state.error}`)}
          </p>
        ) : null}

        {configurationError ? (
          <p role="alert" className="mb-3 text-13 text-[var(--error-fg)]">
            {t('bots.voiceMode.preferenceError')}
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-center gap-2">
        {!active ? (
          <Button
            variant="primary"
            size="lg"
            onClick={() => void start()}
            disabled={loading || props.blocked}
          >
            <Mic size={16} />
            {t(state.unsent ? 'bots.voiceMode.retrySend' : 'bots.voiceMode.resume')}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => controller.toggleMute()}
              disabled={state.phase === 'connecting'}
            >
              <MicOff size={16} />
              {t('bots.voiceMode.mute')}
            </Button>
            {state.phase === 'speaking' || state.phase === 'preparing' ? (
              <Button variant="secondary" size="lg" onClick={() => controller.interrupt()}>
                <VolumeX size={16} />
                {t('bots.voiceMode.interrupt')}
              </Button>
            ) : null}
            {state.transcript ? (
              <Button variant="secondary" size="lg" onClick={() => controller.finishUtterance()}>
                <Send size={16} />
                {t('bots.voiceMode.send')}
              </Button>
            ) : null}
            <Button variant="primary" size="lg" onClick={props.onClose}>
              <PhoneOff size={16} />
              {t('bots.voiceMode.end')}
            </Button>
          </>
        )}
      </div>
      <p className="mt-3 shrink-0 text-center text-12 leading-relaxed text-[var(--text-tertiary)]">
        {t('bots.voiceMode.hint')}
      </p>
    </section>
  );
}
