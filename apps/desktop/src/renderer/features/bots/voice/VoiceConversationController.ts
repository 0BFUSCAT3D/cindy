import type {
  VoiceConversationApi,
  VoiceConversationSelection,
  VoiceExitDecision,
} from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import { createLogger } from '@/lib/logger';
import type { PcmChunk } from '@/voice-input/WebMicAudioEngine';
import type { SpeechPlayer } from './PcmSpeechPlayer';
import { speechChunks, VoiceReplyTracker } from './VoiceReplyTracker';
import { SpeechPlaybackQueue } from './SpeechPlaybackQueue';
import { microphoneDiagnostic } from './microphoneDiagnostics';
import { voiceExitIntent } from './voiceExitIntent';

const log = createLogger('voice-conversation');
// Host idleness includes task/reply/audio activity. This is independent of the
// ASR's 1.25s utterance endpoint and 150s transport rotation.
const IDLE_EXIT_DELAY_MS = 60_000;
const IDLE_COUNTDOWN_MS = 10_000;
const FAREWELL_COUNTDOWN_MS = 3_000;
type ExitReason =
  | 'user'
  | 'idle_timeout'
  | 'voice_command'
  | 'farewell'
  | 'semantic'
  | 'remote_end'
  | 'view_closed'
  | 'view_cleanup'
  | 'account_changed';
type QueuedUtterance = { text: string; id?: string };
type IntentExitReason = 'voice_command' | 'farewell' | 'semantic';

export type VoicePhase =
  | 'idle'
  | 'connecting'
  | 'microphone'
  | 'listening'
  | 'thinking'
  | 'preparing'
  | 'speaking'
  | 'paused'
  | 'error';
export type VoiceSnapshot = {
  phase: VoicePhase;
  transcript: string;
  unsent: string;
  level: number;
  error: 'connection' | 'microphone' | 'send' | 'speech' | null;
  muted: boolean;
  microphonePending: boolean;
  microphoneError: boolean;
  exitCountdown: {
    reason: 'idle' | 'farewell' | 'semantic';
    secondsRemaining: number;
    waitingForSend?: boolean;
  } | null;
};
interface Microphone {
  onPcm16k(callback: (chunk: PcmChunk) => void): void;
  start(): Promise<void>;
  stop(): Promise<unknown>;
}

/** Call-local orchestration. It never stops the companion task or answers permission prompts. */
export class VoiceConversationController {
  private state: VoiceSnapshot = {
    phase: 'idle',
    transcript: '',
    unsent: '',
    level: 0,
    error: null,
    muted: false,
    microphonePending: false,
    microphoneError: false,
    exitCountdown: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private semanticVersion = 0;
  private speechEpoch = 0;
  private callId: string | null = null;
  private microphone: Microphone | null = null;
  private player: SpeechPlayer | null = null;
  private unsubscribe?: () => void;
  private selection?: VoiceConversationSelection;
  private blocked = false;
  private enabled = false;
  private tracker = new VoiceReplyTracker();
  private pendingInput: string | null = null;
  private latestMessages: readonly ChatMessage[] = [];
  private sending = false;
  private inFlight: Promise<void> = Promise.resolve();
  private queued: QueuedUtterance[] = [];
  private latestUtterance: QueuedUtterance | null = null;
  private pendingStart: Promise<unknown> = Promise.resolve();
  private teardown: Promise<unknown> = Promise.resolve();
  private speechCandidate = false;
  private replyPhase: 'thinking' | 'preparing' | 'speaking' | null = null;
  private sentencePlayback = true;
  private replyComplete = false;
  private deferringSpeech = false;
  private playback: SpeechPlaybackQueue | null = null;
  private replyStartedAt = 0;
  private phaseStartedAt = Date.now();
  private candidateStartedAt = 0;
  private captureVersion = 0;
  private inputGeneration = 0;
  private resumingInput = false;
  private inputChange: Promise<void> = Promise.resolve();
  private pendingCapture: Promise<unknown> = Promise.resolve();
  private idleSince: number | null = null;
  private exitDeadline = 0;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private exitVersion = 0;
  private exitAfterSend: { reason: IntentExitReason } | null = null;

  constructor(
    private readonly deps: {
      api: VoiceConversationApi;
      botId: string;
      sessionId: string;
      /** Read the latest task/queue/background activity, including at expiry. */
      isTaskBusy(): boolean;
      onAutoEnd(): void;
      microphone(
        onInterrupted: () => void,
        onStateChange: (event: string, details?: Record<string, unknown>) => void,
      ): Microphone;
      player(onLevel: (level: number) => void): SpeechPlayer;
      send(
        text: string,
        onCreated: (id: string) => void,
        isCurrent: () => boolean,
      ): Promise<boolean>;
    },
  ) {}

  getSnapshot = (): VoiceSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private patch(patch: Partial<VoiceSnapshot>): void {
    if (patch.phase && patch.phase !== this.state.phase) {
      log.info('phase changed', {
        callId: this.callId,
        from: this.state.phase,
        to: patch.phase,
        elapsedMs: Date.now() - this.phaseStartedAt,
        muted: patch.muted ?? this.state.muted,
      });
      this.phaseStartedAt = Date.now();
    }
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
    // PCM level updates are not evidence of speech and must not reset idleness.
    if (Object.keys(patch).some((key) => key !== 'level' && key !== 'exitCountdown'))
      this.refreshActivity();
  }

  private isIdle(): boolean {
    return (
      this.enabled &&
      !!this.callId &&
      !this.blocked &&
      this.state.phase === 'listening' &&
      !this.state.microphonePending &&
      !this.speechCandidate &&
      !this.state.transcript.trim() &&
      !this.state.unsent.trim() &&
      !this.sending &&
      !this.queued.length &&
      !this.pendingInput &&
      !this.playback &&
      !this.replyPhase &&
      !this.deferringSpeech &&
      !this.deps.isTaskBusy()
    );
  }

  /** Called on task activity changes as well as call-local state changes. */
  refreshActivity(): void {
    if (this.hasIntentCountdown()) return;
    if (!this.isIdle()) {
      this.cancelCountdown('activity');
      return;
    }
    this.idleSince ??= Date.now();
    if (this.exitTimer || this.state.exitCountdown) return;
    const remaining = IDLE_EXIT_DELAY_MS - (Date.now() - this.idleSince);
    if (remaining <= 0) this.beginCountdown('idle', IDLE_COUNTDOWN_MS);
    else this.scheduleExitCheck(remaining, () => this.refreshActivity());
  }

  private clearExitTimer(): void {
    clearTimeout(this.exitTimer);
    this.exitTimer = undefined;
    ++this.exitVersion;
  }

  private scheduleExitCheck(delay: number, callback: () => void): void {
    const epoch = this.epoch;
    const version = ++this.exitVersion;
    this.exitTimer = setTimeout(() => {
      if (epoch !== this.epoch || version !== this.exitVersion || !this.enabled || !this.callId)
        return;
      this.exitTimer = undefined;
      callback();
    }, delay);
  }

  private hasIntentCountdown(): boolean {
    return !!this.state.exitCountdown && this.state.exitCountdown.reason !== 'idle';
  }

  private beginCountdown(reason: 'idle' | 'farewell' | 'semantic', delay: number): void {
    this.clearExitTimer();
    this.exitDeadline = Date.now() + delay;
    log.info('exit countdown started', {
      callId: this.callId,
      reason,
      delayMs: delay,
      ...(reason === 'idle' && this.idleSince !== null
        ? { idleMs: Date.now() - this.idleSince }
        : {}),
    });
    this.patch({ exitCountdown: { reason, secondsRemaining: delay / 1000 } });
    this.tickCountdown();
  }

  private tickCountdown(): void {
    const countdown = this.state.exitCountdown;
    if (!countdown) return;
    // Re-read all activity at every tick, including the final boundary. A new
    // task can start after the warning, even without a new ASR event.
    if (countdown.reason === 'idle' && !this.isIdle()) {
      this.refreshActivity();
      return;
    }
    const remaining = this.exitDeadline - Date.now();
    if (remaining <= 0) {
      this.autoEnd(countdown.reason === 'idle' ? 'idle_timeout' : countdown.reason);
      return;
    }
    this.patch({ exitCountdown: { ...countdown, secondsRemaining: Math.ceil(remaining / 1000) } });
    this.scheduleExitCheck(Math.min(1000, remaining), () => this.tickCountdown());
  }

  private cancelCountdown(
    trigger: 'activity' | 'speech' | 'user_continue' | 'control' | 'release',
    resume = true,
  ): void {
    this.clearExitTimer();
    this.idleSince = null;
    this.exitAfterSend = null;
    // New input/control invalidates any background judgment, even before a
    // countdown is visible. Ordinary task projections must not invalidate it.
    if (trigger !== 'activity') ++this.semanticVersion;
    const countdown = this.state.exitCountdown;
    if (!countdown) return;
    log.info('exit countdown cancelled', {
      callId: this.callId,
      reason: countdown.reason,
      trigger,
    });
    this.patch({ exitCountdown: null });
    if (resume && countdown.reason !== 'idle' && !this.speechCandidate) {
      this.player?.resume();
      this.playback?.resume();
      this.setReplyPhase(this.replyPhase);
      this.updateMessages(this.latestMessages);
    }
  }

  cancelExit(): void {
    this.cancelCountdown('user_continue');
    this.refreshActivity();
  }

  private waitForSendBeforeExit(reason: IntentExitReason): void {
    this.clearExitTimer();
    this.exitAfterSend = { reason };
    this.patch({
      exitCountdown: {
        reason: reason === 'voice_command' ? 'semantic' : reason,
        secondsRemaining: 0,
        waitingForSend: true,
      },
    });
    log.info('exit waiting for input acceptance', { callId: this.callId, reason });
  }

  private finishExitAfterSend(): void {
    const pending = this.exitAfterSend;
    if (!pending || this.sending || this.queued.length) return;
    // Only drain's accepted path can reach here with no retained input. Mute,
    // new speech, failures and lifecycle boundaries cancel this intent first.
    if (
      !this.enabled ||
      !this.callId ||
      this.blocked ||
      this.state.unsent ||
      this.speechCandidate ||
      this.state.transcript.trim()
    ) {
      this.cancelCountdown('activity');
      return;
    }
    this.exitAfterSend = null;
    log.info('exit input acceptance confirmed', { callId: this.callId, reason: pending.reason });
    this.autoEnd(pending.reason);
  }

  private autoEnd(reason: 'idle_timeout' | 'voice_command' | 'farewell' | 'semantic'): void {
    // A final utterance can already have left queued[] while send preflight is
    // still awaiting auth/dispatch. Do not invalidate its beforeEnqueue guard.
    if (reason !== 'idle_timeout' && (this.sending || this.queued.length)) {
      this.waitForSendBeforeExit(reason);
      return;
    }
    // A countdown that reached its deadline completed; do not log it as cancelled
    // when the shared release path clears the remaining call state.
    this.clearExitTimer();
    this.patch({ exitCountdown: null });
    this.end(reason);
    this.deps.onAutoEnd();
  }

  async start(
    selection: VoiceConversationSelection,
    sentencePlayback = this.sentencePlayback,
  ): Promise<void> {
    if (this.blocked || this.callId || this.state.phase === 'connecting') return;
    this.selection = selection;
    this.sentencePlayback = sentencePlayback;
    this.enabled = true;
    const epoch = ++this.epoch;
    this.inputGeneration = 0;
    this.patch({
      phase: 'connecting',
      error: null,
      muted: false,
      microphonePending: false,
      microphoneError: false,
    });
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    try {
      this.player = this.deps.player((level) => {
        if (current() && this.state.phase === 'speaking') this.patch({ level });
      });
      await this.teardown;
      if (!current()) return;
      this.unsubscribe = this.deps.api.onEvent(({ callId, inputGeneration = 0, event }) => {
        if (!current() || callId !== this.callId) return;
        if (event.type === 'ended') {
          this.end('remote_end');
          return;
        }
        if (inputGeneration !== this.inputGeneration) return;
        if (this.state.muted) {
          // ASR can disconnect after its resume handshake while getUserMedia is
          // still pending. Do not report listening when that input is gone.
          if (event.type === 'error' && this.resumingInput) this.patch({ microphoneError: true });
          return;
        }
        if (event.type === 'speech-started') {
          this.latestUtterance = null;
          // An acoustic onset can be noise. Pause playback without consuming
          // the reply; only a finalized, nonempty utterance replaces its owner.
          if (!this.speechCandidate) {
            this.speechCandidate = true;
            this.cancelCountdown('speech');
            this.candidateStartedAt = Date.now();
            this.player?.pause();
            this.playback?.pause();
            log.info('reply held for possible speech', { callId, pendingInput: this.pendingInput });
            this.patch({ phase: 'listening', level: 0 });
          }
        } else if (event.type === 'speech-idle') {
          if (this.speechCandidate) {
            this.speechCandidate = false;
            this.player?.resume();
            this.playback?.resume();
            log.info('reply resumed after empty speech', {
              callId,
              pendingInput: this.pendingInput,
              heldMs: Date.now() - this.candidateStartedAt,
            });
            this.setReplyPhase(this.replyPhase);
            this.updateMessages(this.latestMessages);
          }
        } else if (event.type === 'draft') {
          if (event.text.trim()) {
            this.latestUtterance = null;
            this.cancelCountdown('speech');
          }
          this.patch({ transcript: event.text });
        } else if (event.type === 'utterance') {
          this.cancelCountdown('speech');
          // Retained/queued text is part of the utterance's context, so a short
          // trailing farewell must not discard an earlier unfinished thought.
          const intent =
            !this.state.unsent && !this.queued.length ? voiceExitIntent(event.text) : null;
          if (intent === 'command') {
            this.speechCandidate = false;
            this.patch({ transcript: '', level: 0 });
            this.autoEnd('voice_command');
            return;
          }
          if (intent === 'farewell') {
            this.speechCandidate = false;
            this.player?.pause();
            this.playback?.pause();
            this.beginCountdown('farewell', FAREWELL_COUNTDOWN_MS);
            this.patch({ transcript: '', level: 0 });
            return;
          }
          const utterance = { text: event.text, id: event.id };
          this.queued.push(utterance);
          this.latestUtterance = utterance;
          if (
            [this.state.unsent, ...this.queued.map((item) => item.text)].join(' ').length > 16_000
          )
            this.fail('send');
          else void this.drain(epoch);
        } else if (event.type === 'error') {
          this.fail('connection', event.text);
        }
      });
      // Reserve a call id before IPC so End can cancel an in-flight ASR dial.
      this.callId = crypto.randomUUID();
      const opening = this.deps.api.start({
        ...selection,
        callId: this.callId,
        botId: this.deps.botId,
        sessionId: this.deps.sessionId,
      });
      this.pendingStart = opening
        .then(async (result) => {
          if (!current()) await this.deps.api.end(result.callId);
        })
        .catch(() => undefined);
      const result = await opening;
      if (!current()) {
        await this.pendingStart;
        return;
      }
      this.callId = result.callId;
      this.patch({ phase: 'microphone' });
      try {
        const capturing = this.openMicrophone(epoch);
        this.pendingCapture = capturing.catch(() => undefined);
        await capturing;
      } catch {
        if (current()) this.fail('microphone');
        return;
      }
      if (!current()) return;
      this.setReplyPhase(this.pendingInput ? 'thinking' : null);
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('connection');
    }
  }

  private async openMicrophone(epoch: number): Promise<void> {
    const version = ++this.captureVersion;
    const startedAt = Date.now();
    const current = () =>
      this.enabled && epoch === this.epoch && version === this.captureVersion && !this.blocked;
    let firstFrame = true;
    let interrupted = false;
    const mic = this.deps.microphone(
      () => {
        if (!current()) return;
        interrupted = true;
        // During unmute, the caller restores the muted state without stopping TTS.
        if (!this.state.muted) this.fail('microphone');
      },
      (event, details) => {
        if (!current()) return;
        const safe = microphoneDiagnostic(event, details);
        if (safe)
          log.info('microphone capture', {
            callId: this.callId,
            elapsedMs: Date.now() - startedAt,
            ...safe,
          });
      },
    );
    this.microphone = mic;
    mic.onPcm16k(({ pcm16k }) => {
      if (!current() || !this.callId || this.state.muted) return;
      if (firstFrame) {
        firstFrame = false;
        log.info('microphone first frame', {
          callId: this.callId,
          inputGeneration: this.inputGeneration,
          elapsedMs: Date.now() - startedAt,
        });
      }
      this.deps.api.audio({
        callId: this.callId,
        pcm: pcm16k,
        inputGeneration: this.inputGeneration,
      });
      if (this.state.phase !== 'speaking') {
        const samples = new Int16Array(pcm16k);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length),
        );
        this.patch({ level: Math.min(1, rms / 5000) });
      }
    });
    try {
      await mic.start();
      if (interrupted) throw new Error('microphone_interrupted');
      if (current())
        log.info('microphone ready', { callId: this.callId, elapsedMs: Date.now() - startedAt });
    } finally {
      // getUserMedia can resolve after End. Its eventual tracks still need stopping.
      if (!current()) await mic.stop();
    }
  }

  private setReplyPhase(phase: typeof this.replyPhase): void {
    this.replyPhase = phase;
    this.patch({
      phase: this.speechCandidate ? 'listening' : (phase ?? 'listening'),
      level: 0,
    });
  }

  /** Explicit stop or a committed new utterance permanently relinquishes the old reply. */
  interrupt(reason: 'user_stop' | 'new_utterance' = 'user_stop'): void {
    if (reason === 'user_stop') this.cancelCountdown('control');
    log.info('reply interrupted', {
      callId: this.callId,
      reason,
      pendingInput: this.pendingInput,
      ...(this.speechCandidate ? { heldMs: Date.now() - this.candidateStartedAt } : {}),
    });
    ++this.speechEpoch;
    this.playback?.cancel();
    this.playback = null;
    this.replyComplete = false;
    this.deferringSpeech = false;
    this.speechCandidate = false;
    this.replyPhase = null;
    this.tracker.interrupt();
    this.pendingInput = null;
    this.player?.cancel();
    this.player?.resume();
    if (this.callId) void this.deps.api.interrupt(this.callId).catch(() => undefined);
    if (
      this.state.phase === 'speaking' ||
      this.state.phase === 'preparing' ||
      this.state.phase === 'thinking'
    )
      this.patch({ phase: 'listening', level: 0 });
    this.refreshActivity();
  }

  private async submit(
    text: string,
    epoch: number,
    preserveCurrentSpeech = false,
  ): Promise<boolean> {
    const captureVersion = this.captureVersion;
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    const canEnqueue = () => current() && captureVersion === this.captureVersion;
    if (!current()) return false;
    const candidate = this.speechCandidate;
    const transcript = this.state.transcript;
    this.interrupt('new_utterance');
    if (preserveCurrentSpeech) this.speechCandidate = candidate;
    this.setReplyPhase('thinking');
    this.patch({ transcript: preserveCurrentSpeech ? transcript : '', unsent: '' });
    const replyEpoch = this.speechEpoch;
    let clientId: string | null = null;
    try {
      const accepted = await this.deps.send(
        text,
        (id) => {
          clientId = id;
        },
        canEnqueue,
      );
      if (!current()) {
        // Retain only genuinely unsent text across permission/mute boundaries.
        if (!accepted && this.enabled)
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        return accepted && !!clientId;
      }
      if (!accepted || !clientId) {
        if (!canEnqueue()) {
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
          this.setReplyPhase(null);
          return false;
        }
        this.fail('send', text);
        return false;
      }
      if (replyEpoch !== this.speechEpoch) return true;
      log.info('voice input accepted', { callId: this.callId, clientId, characters: text.length });
      this.pendingInput = clientId;
      this.replyStartedAt = Date.now();
      this.tracker.expect(clientId);
      this.updateMessages(this.latestMessages);
      return true;
    } catch {
      if (canEnqueue()) this.fail('send', text);
      else if (this.enabled) {
        this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        if (current() && replyEpoch === this.speechEpoch) this.setReplyPhase(null);
      }
      return false;
    }
  }

  private async submitAndCheckExit(utterance: QueuedUtterance, epoch: number): Promise<void> {
    const text = [this.state.unsent, utterance.text].filter(Boolean).join(' ');
    // Never classify only a suffix of retained/queued input or a manual retry.
    const canJudge =
      !!utterance.id &&
      this.latestUtterance === utterance &&
      !this.state.unsent &&
      !this.queued.length;
    const callId = this.callId!;
    const captureVersion = this.captureVersion;
    const semanticVersion = this.semanticVersion;
    const current = () =>
      this.enabled &&
      this.epoch === epoch &&
      this.callId === callId &&
      !this.blocked &&
      captureVersion === this.captureVersion &&
      semanticVersion === this.semanticVersion &&
      !this.state.muted &&
      this.latestUtterance === utterance &&
      !this.speechCandidate &&
      !this.queued.length &&
      !this.state.unsent;

    // Dispatch through the normal companion path immediately. Semantic judging
    // is a sidecar: it cannot delay the user message, the next send or TTS. Once
    // submitted, even a pure semantic EXIT never retracts/restores that message.
    // Local whole-utterance controls above remain voice-only and are not sent.
    log.info('voice input dispatch started', { callId, characters: text.length });
    const submitted = this.submit(text, epoch, this.latestUtterance !== utterance);
    if (canJudge) void this.checkExitAfterSubmit(callId, utterance.id!, submitted, current);
    await submitted;
  }

  private async checkExitAfterSubmit(
    callId: string,
    utteranceId: string,
    submitted: Promise<boolean>,
    current: () => boolean,
  ): Promise<void> {
    let decision: VoiceExitDecision = false;
    try {
      decision = await this.deps.api.classifyExit(callId, utteranceId, this.inputGeneration);
    } catch {
      // Failure/timeout affects only automatic exit; the message is already on
      // its normal send path and must not be retried by this observer.
    }
    if (!decision || !current()) return;
    if (decision === 'submit_then_exit') this.waitForSendBeforeExit('semantic');
    if (!(await submitted) || !current()) return;
    if (decision === 'submit_then_exit') {
      // If drain still owns the send, its finally completes this same check.
      this.finishExitAfterSend();
    } else {
      this.player?.pause();
      this.playback?.pause();
      this.beginCountdown('semantic', FAREWELL_COUNTDOWN_MS);
    }
  }

  private async drain(epoch: number): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queued.length && this.enabled && epoch === this.epoch && !this.blocked) {
        // A muted preflight can settle after input has resumed. Merge retained
        // text here so a newer queued utterance cannot erase that late result.
        this.inFlight = this.submitAndCheckExit(this.queued.shift()!, epoch);
        await this.inFlight;
      }
    } finally {
      this.sending = false;
      this.finishExitAfterSend();
      if (this.queued.length && this.callId && this.enabled && !this.blocked)
        void this.drain(this.epoch);
      this.refreshActivity();
    }
  }

  updateMessages(messages: readonly ChatMessage[]): void {
    if (messages !== this.latestMessages && !this.hasIntentCountdown())
      this.cancelCountdown('activity');
    this.latestMessages = messages;
    this.refreshActivity();
    if (
      !this.enabled ||
      !this.callId ||
      this.blocked ||
      !this.pendingInput ||
      this.speechCandidate ||
      this.hasIntentCountdown() ||
      this.deferringSpeech
    )
      return;
    const inputIndex = messages.findIndex((message) => message.clientId === this.pendingInput);
    if (
      inputIndex >= 0 &&
      messages.slice(inputIndex + 1).some((message) => message.role === 'user')
    ) {
      this.interrupt();
      return;
    }
    const reply = this.tracker.take(messages, this.sentencePlayback);
    if (!reply) {
      if (!this.tracker.hasPendingReply && !this.replyComplete) {
        log.info('reply ownership superseded', {
          callId: this.callId,
          pendingInput: this.pendingInput,
        });
        this.interrupt();
      }
      return;
    }
    if (reply.invalidated) {
      log.info('speech prefix replaced', { callId: this.callId, replyId: reply.id });
      this.interrupt();
      return;
    }
    this.replyComplete = reply.complete;
    log.info('reply speech available', {
      callId: this.callId,
      replyId: reply.id,
      characters: reply.text.length,
      complete: reply.complete,
      elapsedMs: Date.now() - this.replyStartedAt,
    });
    if (!this.playback) this.playback = this.createPlayback();
    this.playback?.append(
      speechChunks(reply.text, this.sentencePlayback ? 500 : 3_500),
      reply.complete,
    );
  }

  private createPlayback(): SpeechPlaybackQueue | null {
    const epoch = this.epoch;
    const speechEpoch = ++this.speechEpoch;
    const callId = this.callId;
    const player = this.player;
    if (!callId || !player) return null;
    const current = () =>
      epoch === this.epoch && speechEpoch === this.speechEpoch && this.enabled && !this.blocked;
    return new SpeechPlaybackQueue({
      api: this.deps.api,
      callId,
      prefix: String(speechEpoch),
      player,
      prefetch: this.sentencePlayback,
      phase: (phase) => {
        if (current()) this.setReplyPhase(phase);
      },
      drained: () => {
        if (!current()) return;
        this.pendingInput = null;
        this.playback = null;
        this.refreshActivity();
      },
      deferred: (alreadyPlayed) => {
        if (!current()) return;
        if (alreadyPlayed || !this.pendingInput) {
          this.interrupt();
          return;
        }
        ++this.speechEpoch;
        this.playback = null;
        this.replyComplete = false;
        this.deferringSpeech = true;
        this.tracker.expect(this.pendingInput);
        this.tracker.deferUntilComplete();
        this.setReplyPhase('thinking');
        const deferredEpoch = this.speechEpoch;
        void this.deps.api
          .interrupt(callId)
          .then(() => {
            if (epoch === this.epoch && deferredEpoch === this.speechEpoch) {
              this.deferringSpeech = false;
              this.updateMessages(this.latestMessages);
            }
          })
          .catch(() => {
            if (epoch === this.epoch && deferredEpoch === this.speechEpoch) this.fail('speech');
          });
      },
      failed: () => {
        if (current()) this.fail('speech');
      },
      diagnostic: (event, details) => {
        if (current())
          log.info(event, { callId, elapsedMs: Date.now() - this.replyStartedAt, ...details });
      },
    });
  }

  finishUtterance(): void {
    this.cancelCountdown('control');
    const epoch = this.epoch;
    if (this.callId && !this.state.muted && !this.state.microphonePending)
      void this.deps.api.finishUtterance(this.callId).catch(() => {
        if (epoch === this.epoch) this.fail('connection');
      });
  }

  setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked && this.enabled) {
      this.cancelCountdown('control', false);
      const unsent = [
        this.state.unsent,
        ...this.queued.map((item) => item.text),
        this.state.transcript,
      ]
        .filter(Boolean)
        .join(' ');
      this.release();
      this.patch({
        phase: 'paused',
        unsent,
        transcript: '',
        level: 0,
        microphonePending: false,
        microphoneError: false,
      });
    }
    // Confirmation completion does not silently restart a microphone.
  }

  toggleMute(): Promise<void> {
    if (
      !this.callId ||
      this.state.microphonePending ||
      ['connecting', 'microphone'].includes(this.state.phase)
    )
      return this.inputChange;
    const epoch = this.epoch;
    const callId = this.callId;
    this.cancelCountdown('control');
    const unmuting = this.state.muted;
    this.resumingInput = unmuting;
    const startedAt = Date.now();
    const current = () =>
      this.enabled && epoch === this.epoch && this.callId === callId && !this.blocked;
    this.patch({ microphonePending: true, microphoneError: false });
    if (!unmuting) {
      ++this.captureVersion;
      const unsent = [
        this.state.unsent,
        ...this.queued.map((item) => item.text),
        this.state.transcript,
      ]
        .filter(Boolean)
        .join(' ');
      this.queued = [];
      this.patch({ muted: true, transcript: '', unsent });
      // A possible interruption can no longer be confirmed with the mic closed.
      // Restore the held reply instead of discarding its playback/ownership.
      if (this.speechCandidate) {
        this.speechCandidate = false;
        this.player?.resume();
        this.playback?.resume();
        log.info('reply resumed on microphone mute', {
          callId,
          heldMs: Date.now() - this.candidateStartedAt,
        });
      }
      this.setReplyPhase(this.replyPhase);
      this.updateMessages(this.latestMessages);
    }
    const mic = this.microphone;
    if (!unmuting) this.microphone = null;
    this.inputChange = (async () => {
      let stage: 'asr' | 'microphone' = 'asr';
      try {
        if (!unmuting) {
          const [result] = await Promise.all([
            this.deps.api.setInputMuted(callId, true),
            mic?.stop().catch(() => {
              // Tracks and PCM forwarding stop before AudioContext cleanup.
              // A failed context close must not silence the companion's reply.
              log.warn('microphone cleanup failed', { callId });
            }),
          ]);
          if (current()) this.inputGeneration = result.inputGeneration;
        } else {
          const result = await this.deps.api.setInputMuted(callId, false);
          if (!current()) return;
          this.inputGeneration = result.inputGeneration;
          stage = 'microphone';
          await this.openMicrophone(epoch);
          if (!current()) return;
          if (this.state.microphoneError) {
            stage = 'asr';
            throw new Error('input_ended');
          }
          this.patch({ muted: false });
        }
        if (current())
          log.info('microphone mute changed', {
            callId,
            muted: !unmuting,
            elapsedMs: Date.now() - startedAt,
          });
      } catch {
        if (!current()) return;
        if (!unmuting) {
          this.fail('connection');
          return;
        }
        // Failure to restore capture must not cancel the reply the user is hearing.
        ++this.captureVersion;
        const failedMic = this.microphone;
        this.microphone = null;
        this.patch({ muted: true, microphoneError: true });
        await Promise.allSettled([failedMic?.stop(), this.deps.api.setInputMuted(callId, true)]);
        log.warn('microphone resume failed', { callId, stage, elapsedMs: Date.now() - startedAt });
      } finally {
        if (current()) {
          this.resumingInput = false;
          this.patch({ microphonePending: false });
        }
      }
    })();
    return this.inputChange;
  }

  retryUnsent(): void {
    if (!this.state.unsent || !this.callId || this.blocked) return;
    this.cancelCountdown('control');
    const text = this.state.unsent;
    this.patch({ unsent: '' });
    this.queued.push({ text });
    void this.drain(this.epoch);
  }

  private fail(error: VoiceSnapshot['error'], text?: string): void {
    this.cancelCountdown('control', false);
    log.warn('voice mode failed', { callId: this.callId, phase: this.state.phase, reason: error });
    const unsent = [
      this.state.unsent,
      text || this.state.transcript,
      ...this.queued.map((item) => item.text),
    ]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({
      phase: 'error',
      error,
      unsent,
      transcript: '',
      level: 0,
      microphonePending: false,
      microphoneError: false,
    });
  }

  private release(): void {
    this.cancelCountdown('release', false);
    ++this.epoch;
    this.resumingInput = false;
    ++this.captureVersion;
    ++this.speechEpoch;
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
      this.tracker.interrupt();
      this.pendingInput = null;
    }
    this.replyComplete = false;
    this.deferringSpeech = false;
    this.speechCandidate = false;
    this.replyPhase = null;
    this.queued = [];
    this.latestUtterance = null;
    const callId = this.callId;
    const microphone = this.microphone;
    const releasedAt = Date.now();
    this.callId = null;
    this.microphone = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.player?.close();
    this.player = null;
    this.teardown = Promise.allSettled([
      this.teardown,
      this.pendingStart,
      this.pendingCapture,
      this.inputChange,
      this.inFlight,
      microphone?.stop(),
      callId ? this.deps.api.end(callId) : undefined,
    ]).then((results) => {
      if (callId)
        log.info('voice resources released', {
          callId,
          elapsedMs: Date.now() - releasedAt,
          failedOperations: results.filter((result) => result.status === 'rejected').length,
        });
    });
  }

  end(reason: ExitReason = 'user'): void {
    if (this.callId) log.info('voice mode ended', { callId: this.callId, reason });
    this.enabled = false;
    this.release();
    this.tracker.interrupt();
    this.pendingInput = null;
    this.patch({
      phase: 'idle',
      transcript: '',
      level: 0,
      muted: false,
      microphonePending: false,
      microphoneError: false,
    });
  }
}
