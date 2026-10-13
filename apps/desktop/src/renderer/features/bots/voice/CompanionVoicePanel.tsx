import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AudioLines, Mic, MicOff, PhoneOff, RefreshCw, Send, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import type { ChatMessage } from '@/lib/makerChatStore';
import { WebMicAudioEngine } from '@/voice-input/WebMicAudioEngine';
import { getVoiceInputWorkletUrl } from '@/voice-input/workletUrl';
import type {
  SpeechProtocol,
  VoiceConversationModel,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import { normalizeVoiceConversationSelection, voiceModelKey } from '@/../shared/voiceConversation';
import { referenceSpeechVoices } from '@/../shared/speechVoices';
import { BotAvatar } from '../BotAvatar';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import { VoiceConversationController } from './VoiceConversationController';
import { PcmSpeechPlayer } from './PcmSpeechPlayer';
import { VoicePreviewController } from './VoicePreviewController';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import './voiceConversation.css';

type Props = {
  bot: BotChatIdentity;
  sessionId: string;
  messages: readonly ChatMessage[];
  blocked: boolean;
  onClose(): void;
  onSend(text: string, onCreated: (id: string) => void, isCurrent: () => boolean): Promise<boolean>;
};

export function CompanionVoicePanel(props: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const latest = useRef(props);
  latest.current = props;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [models, setModels] = useState<VoiceConversationModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [preference, setPreference] = useState<VoiceConversationSelection | null>(null);
  const [voice, setVoice] = useState<string>();
  const [customized, setCustomized] = useState(false);
  const [preferenceOwner, setPreferenceOwner] = useState<string>();
  const [preferenceError, setPreferenceError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const dirty = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const ready = preferenceOwner === props.bot.id;
  const selectedModel = preference
    ? models.find((model) => voiceModelKey(model) === voiceModelKey(preference))
    : models[0];
  const validModel = !!selectedModel;
  const protocolOverride = selectedModel?.protocolLocked ? undefined : preference?.protocol;
  const incompatibleSavedProtocol =
    selectedModel?.protocolLocked &&
    preference?.protocol !== undefined &&
    preference.protocol !== selectedModel.protocol;
  // A voice saved for another adapter is not portable. Keep the stored preference
  // intact until the user chooses a voice; never persist a derived default on load.
  const selectedVoice =
    voice ??
    (incompatibleSavedProtocol ? '' : (preference?.voice ?? selectedModel?.defaultVoice ?? ''));
  const selection = normalizeVoiceConversationSelection({
    providerId: selectedModel?.providerId,
    agent: selectedModel?.agent,
    modelId: selectedModel?.id,
    protocol: protocolOverride,
    voice: selectedVoice,
  });
  const protocol =
    protocolOverride ??
    selectedModel?.protocol ??
    ((selectedModel?.providerId ?? 'xd') === 'xd' ? 'openai' : undefined);
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
  const preview = useMemo(
    () =>
      new VoicePreviewController({
        api: window.electronAPI.voiceConversation,
        botId: props.bot.id,
        sessionId: props.sessionId,
        player: () => new PcmSpeechPlayer(() => undefined),
      }),
    [props.bot.id, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const active = ['connecting', 'listening', 'thinking', 'preparing', 'speaking'].includes(
    state.phase,
  );
  const refreshVersion = useRef(0);
  const preferenceVersion = useRef(0);
  const refresh = useCallback(async (fetchCatalog = false) => {
    const version = ++refreshVersion.current;
    setLoading(true);
    setCatalogError(false);
    try {
      // A Gateway refresh failure must not hide usable local BYOK connections.
      if (fetchCatalog)
        await window.electronAPI.maker.refreshBuiltinProviderModels('xd').catch(() => undefined);
      const next = await window.electronAPI.voiceConversation.models();
      if (version === refreshVersion.current) setModels(next);
    } catch {
      if (version === refreshVersion.current) setCatalogError(true);
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  const loadPreference = useCallback(() => {
    const version = ++preferenceVersion.current;
    setPreferenceOwner(undefined);
    setPreferenceError(false);
    setPreference(null);
    setVoice(undefined);
    setCustomized(false);
    setSaving(false);
    dirty.current = false;
    pendingSave.current = null;
    void window.electronAPI.voiceConversation
      .preference(props.bot.id)
      .then((result) => {
        if (version !== preferenceVersion.current) return;
        setPreference(result.selection);
        setCustomized(result.customized);
        setPreferenceOwner(props.bot.id);
      })
      .catch(() => {
        if (version === preferenceVersion.current) setPreferenceError(true);
      });
  }, [props.bot.id]);

  useEffect(() => {
    void refresh();
    loadPreference();
    titleRef.current?.focus();
    return () => {
      ++refreshVersion.current;
      ++preferenceVersion.current;
      controller.end();
      void preview.stop();
    };
  }, [controller, preview, loadPreference, refresh]);
  useEffect(() => {
    controller.setBlocked(props.blocked);
    if (props.blocked) void preview.stop();
  }, [controller, preview, props.blocked]);
  useEffect(() => controller.updateMessages(props.messages), [controller, props.messages]);
  useEffect(() => {
    const initialOwner = getDataOwnerGeneration();
    let owner = `${initialOwner.dataOwnerId}:${initialOwner.generation}`;
    const removeAuth = window.electronAPI.onAuthStateChange((next) => {
      const key = `${next.dataOwnerId}:${next.ownerGeneration}`;
      if (next.ownerBoundaryPending || key !== owner) {
        controller.end();
        void preview.stop();
        latest.current.onClose();
      }
      owner = key;
    });
    const removePower = window.electronAPI.voiceInput.onPowerStateChange(() => {
      controller.setBlocked(true);
      void preview.stop();
    });
    const hidden = () => {
      if (document.hidden) void preview.stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      removeAuth();
      removePower();
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [controller, preview]);

  const persist = (next: VoiceConversationSelection | null): Promise<boolean> => {
    if (pendingSave.current) return pendingSave.current;
    const version = preferenceVersion.current;
    setSaving(true);
    setPreferenceError(false);
    const pending = window.electronAPI.voiceConversation
      .setPreference(props.bot.id, next)
      .then((result) => {
        if (version !== preferenceVersion.current) return false;
        setPreference(result.selection);
        setCustomized(result.customized);
        setVoice(undefined);
        dirty.current = false;
        return true;
      })
      .catch(() => {
        if (version === preferenceVersion.current) setPreferenceError(true);
        return false;
      })
      .finally(() => {
        if (version === preferenceVersion.current) {
          setSaving(false);
          pendingSave.current = null;
        }
      });
    pendingSave.current = pending;
    return pending;
  };
  const start = async () => {
    if (startingRef.current || !selection || !validModel || !protocol || props.blocked || !ready)
      return;
    startingRef.current = true;
    setStarting(true);
    const version = preferenceVersion.current;
    try {
      await preview.stop();
      if (version !== preferenceVersion.current || latest.current.blocked) return;
      if (dirty.current && !(await persist(selection))) return;
      if (version !== preferenceVersion.current || latest.current.blocked) return;
      controller.setBlocked(false);
      await controller.start(selection);
      controller.retryUnsent();
    } finally {
      startingRef.current = false;
      if (version === preferenceVersion.current) setStarting(false);
    }
  };
  const chooseModel = (key: string) => {
    const model = models.find((item) => voiceModelKey(item) === key);
    if (!model) return;
    const next = {
      providerId: model.providerId,
      agent: model.agent,
      modelId: model.id,
      // Voice compatibility is model-specific, even within the same connection/protocol.
      voice: model.defaultVoice ?? '',
    };
    void preview.stop();
    dirty.current = true;
    setCustomized(true);
    setPreference(next);
    setVoice(next.voice);
    if (normalizeVoiceConversationSelection(next)) void persist(next);
  };
  const status = props.blocked ? 'confirmation' : state.phase;

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

        {!active ? (
          <div className="space-y-3">
            {catalogError || (!loading && models.length === 0) ? (
              <p className="text-13 text-[var(--text-secondary)]">
                {t(catalogError ? 'bots.voiceMode.catalogError' : 'bots.voiceMode.noModels')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-start gap-3">
              <FormField label={t('bots.voiceMode.model')} className="min-w-52 flex-[2]">
                {(control) => (
                  <div className="flex items-center gap-2">
                    <Select
                      {...control}
                      label={t('bots.voiceMode.model')}
                      value={selectedModel ? voiceModelKey(selectedModel) : ''}
                      options={models.map((model) => ({
                        value: voiceModelKey(model),
                        label: [model.name, model.providerName].filter(Boolean).join(' · '),
                      }))}
                      onValueChange={chooseModel}
                      disabled={loading || !ready || saving || starting || models.length === 0}
                      className="flex-1"
                    />
                    <Button
                      variant="secondary"
                      size="lg"
                      className="w-9 shrink-0 px-0"
                      disabled={loading || starting}
                      aria-label={t('bots.voiceMode.refresh')}
                      title={t('bots.voiceMode.refresh')}
                      onClick={() => {
                        void refresh(true);
                        if (!ready) loadPreference();
                      }}
                    >
                      <RefreshCw size={15} />
                    </Button>
                  </div>
                )}
              </FormField>
              {!validModel && preference && models.length > 0 ? (
                <p className="w-full text-12 text-[var(--text-secondary)]">
                  {t('bots.voiceMode.modelUnavailable')}
                </p>
              ) : null}
              {selectedModel && selectedModel.providerId !== 'xd' && selectedModel.agent ? (
                <FormField
                  label={t('bots.voiceMode.protocol')}
                  hint={t(
                    incompatibleSavedProtocol && voice === undefined
                      ? 'bots.voiceMode.protocolCorrectedHint'
                      : selectedModel.protocolLocked
                        ? 'bots.voiceMode.protocolAutomaticHint'
                        : 'bots.voiceMode.protocolHint',
                  )}
                  className="min-w-52 flex-1"
                >
                  {(control) => (
                    <Select
                      {...control}
                      label={t('bots.voiceMode.protocol')}
                      value={protocol ?? ''}
                      options={[
                        { value: 'openai', label: t('bots.voiceMode.protocolOpenai') },
                        { value: 'elevenlabs', label: 'ElevenLabs' },
                        { value: 'minimax', label: 'MiniMax' },
                      ].filter(
                        (option) => !selectedModel.protocolLocked || option.value === protocol,
                      )}
                      disabled={selectedModel.protocolLocked || !ready || saving || starting}
                      onValueChange={(value) => {
                        if (selectedModel.protocolLocked) return;
                        const next = {
                          providerId: selectedModel.providerId,
                          agent: selectedModel.agent,
                          modelId: selectedModel.id,
                          voice:
                            referenceSpeechVoices(selectedModel.id, value as SpeechProtocol)[0] ??
                            '',
                          protocol: value as SpeechProtocol,
                        };
                        void preview.stop();
                        dirty.current = true;
                        setCustomized(true);
                        setPreference(next);
                        setVoice(next.voice);
                        if (normalizeVoiceConversationSelection(next)) void persist(next);
                      }}
                      className="w-full"
                    />
                  )}
                </FormField>
              ) : null}
            </div>
            {selectedModel ? (
              <SpeechVoicePicker
                route={{
                  providerId: selectedModel.providerId,
                  agent: selectedModel.agent,
                  modelId: selectedModel.id,
                  protocol: protocolOverride,
                }}
                protocol={protocol}
                voice={selectedVoice}
                disabled={!ready || saving || starting || props.blocked}
                previewDisabled={!ready || starting || props.blocked}
                preview={preview}
                onChange={(value, save) => {
                  dirty.current = true;
                  setVoice(value);
                  const next = normalizeVoiceConversationSelection({
                    providerId: selectedModel.providerId,
                    agent: selectedModel.agent,
                    modelId: selectedModel.id,
                    protocol: protocolOverride,
                    voice: value,
                  });
                  if (save && next && validModel) void persist(next);
                }}
              />
            ) : null}
            {preferenceError ? (
              <p role="alert" className="text-13 text-[var(--error-fg)]">
                {t('bots.voiceMode.preferenceError')}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1 text-12 text-[var(--text-tertiary)]">
                {t('bots.voiceMode.preferenceHint')}
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={!ready || saving || starting || (!customized && !dirty.current)}
                onClick={() => void persist(null)}
              >
                {t('bots.voiceMode.resetPreference')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-center gap-2">
        {!active ? (
          <Button
            variant="primary"
            size="lg"
            onClick={() => void start()}
            disabled={
              starting ||
              !validModel ||
              !selection ||
              !protocol ||
              props.blocked ||
              loading ||
              !ready
            }
          >
            <Mic size={16} />
            {t(
              state.unsent
                ? 'bots.voiceMode.retrySend'
                : state.phase === 'idle'
                  ? 'bots.voiceMode.start'
                  : 'bots.voiceMode.resume',
            )}
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
            <Button variant="primary" size="lg" onClick={() => controller.end()}>
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
