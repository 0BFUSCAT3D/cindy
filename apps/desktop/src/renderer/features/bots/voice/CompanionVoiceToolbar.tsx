import { useId, useRef, useState, type RefObject } from 'react';
import { MessageSquareText, Mic, MicOff, PhoneOff, Send, Settings2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { BotAvatar } from '../BotAvatar';
import type { BotChatIdentity } from '../BotSessionContentHeader';
import type { VoiceSnapshot } from './VoiceConversationController';
import './voiceConversation.css';

type Props = {
  bot: BotChatIdentity;
  state: VoiceSnapshot;
  loading: boolean;
  blocked: boolean;
  configurationError: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onResume(): void;
  onMute(): void;
  onInterrupt(): void;
  onSend(): void;
  onCancelExit(): void;
  onClose(): void;
  onConfigure(): void;
};

/** Presentation only: expanding details must never recreate capture, playback or exit timers. */
export function CompanionVoiceToolbar(props: Props) {
  const { t } = useTranslation();
  const { state } = props;
  const labelId = useId();
  const detailsId = useId();
  const hintId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const active =
    !props.blocked &&
    (props.loading ||
      ['connecting', 'microphone', 'listening', 'thinking', 'preparing', 'speaking'].includes(
        state.phase,
      ));
  const status = props.blocked
    ? 'confirmation'
    : props.loading && state.phase === 'idle'
      ? 'loading'
      : state.muted && state.phase === 'listening'
        ? 'muted'
        : state.phase;
  const waiting = ['loading', 'connecting', 'microphone', 'thinking', 'preparing'].includes(status);
  const wave = status === 'listening' || status === 'speaking';
  // A late send failure can coexist with new input. Keep both visible; the
  // controller still owns their ordering and the existing retry/send action.
  const text = [state.unsent, state.transcript].filter(Boolean).join('\n');
  const detailsLabel = t(expanded ? 'bots.voiceMode.hideDetails' : 'bots.voiceMode.showDetails');
  const muteLabel = t(state.muted ? 'bots.voiceMode.unmute' : 'bots.voiceMode.mute');
  const hint = t(
    state.exitCountdown
      ? state.muted
        ? 'bots.voiceMode.exit.mutedHint'
        : 'bots.voiceMode.exit.hint'
      : state.muted
        ? 'bots.voiceMode.mutedHint'
        : 'bots.voiceMode.hint',
  );
  const send =
    text && active ? (
      <Button
        variant="secondary"
        tone="quiet"
        size="md"
        compact
        disabled={state.microphonePending}
        onClick={props.onSend}
      >
        <Send size={14} aria-hidden="true" />
        {t('bots.voiceMode.send')}
      </Button>
    ) : null;

  return (
    <section
      className="companion-voice-toolbar"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      onKeyDown={(event) => {
        // Escape dismisses only the disclosure, never the live call or a pending exit.
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation();
          setExpanded(false);
          detailsButton.current?.focus();
        }
      }}
    >
      <h2 ref={props.titleRef} tabIndex={-1} id={labelId} className="sr-only outline-none">
        {t('bots.voiceMode.title')}
      </h2>
      <p id={hintId} className="sr-only">
        {hint}
      </p>
      {expanded ? (
        <div id={detailsId} className="companion-voice-details">
          <div className="flex items-center justify-between gap-2 text-12 text-[var(--text-secondary)]">
            <span>{t('bots.voiceMode.transcriptTitle')}</span>
            <Tip text={t('bots.voiceMode.openSettings')}>
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                className="w-8 px-0"
                aria-label={t('bots.voiceMode.openSettings')}
                onClick={props.onConfigure}
              >
                <Settings2 size={16} aria-hidden="true" />
              </Button>
            </Tip>
          </div>
          <p className="my-2 max-h-24 select-text overflow-y-auto whitespace-pre-wrap break-words text-13 leading-relaxed">
            {text || t('bots.voiceMode.transcriptEmpty')}
          </p>
          <div className="flex items-center justify-between gap-2 text-12 text-[var(--text-tertiary)]">
            <span>{state.unsent ? t('bots.voiceMode.unsent') : hint}</span>
            {send}
          </div>
        </div>
      ) : null}
      <div className="companion-voice-bar">
        <div className="companion-voice-identity">
          <BotAvatar bot={props.bot} size="sm" className="h-8 w-8" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-13 font-medium">{props.bot.name}</span>
              <span className="companion-voice-mode-label text-11 text-[var(--text-tertiary)]">
                {t('bots.voiceMode.title')}
              </span>
            </div>
            <p
              className="mt-1 text-12 leading-4 text-[var(--text-secondary)]"
              role="status"
              aria-live="polite"
            >
              {state.exitCountdown
                ? t(`bots.voiceMode.exit.${state.exitCountdown.reason}`)
                : t(`bots.voiceMode.status.${status}`)}
            </p>
            {state.exitCountdown ? (
              <p
                role="timer"
                aria-live="off"
                className="mt-0.5 text-12 tabular-nums text-[var(--text-secondary)]"
              >
                {t('bots.voiceMode.exit.countdown', {
                  seconds: state.exitCountdown.secondsRemaining,
                })}
              </p>
            ) : state.muted && status !== 'muted' ? (
              <p className="mt-0.5 text-11 text-[var(--text-tertiary)]">
                {t('bots.voiceMode.microphoneMuted')}
              </p>
            ) : null}
          </div>
        </div>
        <div className="companion-voice-actions">
          {state.exitCountdown ? (
            <Button variant="secondary" size="md" compact onClick={props.onCancelExit}>
              {t('bots.voiceMode.exit.cancel')}
            </Button>
          ) : !active ? (
            <Button
              variant="secondary"
              size="md"
              compact
              onClick={props.onResume}
              disabled={props.loading || props.blocked}
            >
              {t(state.unsent ? 'bots.voiceMode.retrySend' : 'bots.voiceMode.resume')}
            </Button>
          ) : (
            <div className="companion-voice-activity" aria-hidden="true" data-activity={status}>
              {waiting ? (
                <Spinner size={18} />
              ) : wave ? (
                <div className="companion-voice-meter">
                  {[0.4, 0.7, 1, 0.65, 0.9, 0.5, 0.75].map((weight, index) => (
                    <span
                      key={index}
                      style={{ transform: `scaleY(${0.12 + state.level * weight * 0.88})` }}
                    />
                  ))}
                </div>
              ) : (
                <MicOff size={18} />
              )}
            </div>
          )}
          <Tip text={detailsLabel}>
            <Button
              ref={detailsButton}
              variant="secondary"
              tone="quiet"
              size="md"
              className="w-8 px-0"
              aria-label={detailsLabel}
              aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined}
              onClick={() => setExpanded(!expanded)}
            >
              <MessageSquareText size={16} aria-hidden="true" />
            </Button>
          </Tip>
          {active ? (
            <Tip text={muteLabel}>
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                className="w-8 px-0"
                aria-label={muteLabel}
                aria-pressed={state.muted}
                onClick={props.onMute}
                loading={state.microphonePending}
                disabled={
                  props.loading || state.phase === 'connecting' || state.phase === 'microphone'
                }
              >
                {state.muted ? (
                  <MicOff size={16} aria-hidden="true" />
                ) : (
                  <Mic size={16} aria-hidden="true" />
                )}
              </Button>
            </Tip>
          ) : null}
          {state.phase === 'speaking' || state.phase === 'preparing' ? (
            <Tip text={t('bots.voiceMode.interrupt')}>
              <Button
                variant="secondary"
                tone="quiet"
                size="md"
                className="w-8 px-0"
                aria-label={t('bots.voiceMode.interrupt')}
                onClick={props.onInterrupt}
              >
                <VolumeX size={16} aria-hidden="true" />
              </Button>
            </Tip>
          ) : null}
          <span className="mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]" aria-hidden="true" />
          <Button variant="secondary" size="md" compact onClick={props.onClose}>
            <PhoneOff size={16} aria-hidden="true" />
            {t('bots.voiceMode.end')}
          </Button>
        </div>
      </div>
      {!expanded && text ? (
        <div className="companion-voice-caption">
          <div className="min-w-0 flex-1">
            {state.unsent ? (
              <p className="text-11 text-[var(--text-tertiary)]">{t('bots.voiceMode.unsent')}</p>
            ) : null}
            <p className="truncate select-text text-12">{text}</p>
          </div>
          {send}
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="companion-voice-error">
          {t(`bots.voiceMode.errors.${state.error}`)}
        </p>
      ) : null}
      {state.microphoneError ? (
        <p role="alert" className="companion-voice-error">
          {t('bots.voiceMode.microphoneResumeError')}
        </p>
      ) : null}
      {props.configurationError ? (
        <p role="alert" className="companion-voice-error">
          {t('bots.voiceMode.preferenceError')}
        </p>
      ) : null}
    </section>
  );
}
