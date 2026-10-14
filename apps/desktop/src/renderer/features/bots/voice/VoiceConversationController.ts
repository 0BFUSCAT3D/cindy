import type {
  VoiceConversationApi,
  VoiceConversationSelection,
} from '@/../shared/voiceConversation';
import type { ChatMessage } from '@/lib/makerChatStore';
import { createLogger } from '@/lib/logger';
import type { PcmChunk } from '@/voice-input/WebMicAudioEngine';
import type { SpeechPlayer } from './PcmSpeechPlayer';
import { speechChunks, VoiceReplyTracker } from './VoiceReplyTracker';

const log = createLogger('voice-conversation');

export type VoicePhase =
  'idle' | 'connecting' | 'listening' | 'thinking' | 'preparing' | 'speaking' | 'paused' | 'error';
export type VoiceSnapshot = {
  phase: VoicePhase;
  transcript: string;
  unsent: string;
  level: number;
  error: 'connection' | 'microphone' | 'send' | 'speech' | null;
  muted: boolean;
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
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
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
  private queued: string[] = [];
  private pendingStart: Promise<unknown> = Promise.resolve();
  private teardown: Promise<unknown> = Promise.resolve();
  private speechCandidate = false;
  private replyPhase: 'thinking' | 'preparing' | 'speaking' | null = null;

  constructor(
    private readonly deps: {
      api: VoiceConversationApi;
      botId: string;
      sessionId: string;
      microphone(onInterrupted: () => void): Microphone;
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
    if (patch.phase && patch.phase !== this.state.phase)
      log.info('phase changed', { callId: this.callId, from: this.state.phase, to: patch.phase });
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(selection: VoiceConversationSelection): Promise<void> {
    if (this.blocked || this.callId || this.state.phase === 'connecting') return;
    this.selection = selection;
    this.enabled = true;
    const epoch = ++this.epoch;
    this.patch({ phase: 'connecting', error: null, muted: false });
    const current = () => this.enabled && epoch === this.epoch && !this.blocked;
    try {
      this.player = this.deps.player((level) => {
        if (current() && this.state.phase === 'speaking') this.patch({ level });
      });
      await this.teardown;
      if (!current()) return;
      this.unsubscribe = this.deps.api.onEvent(({ callId, event }) => {
        if (!current() || callId !== this.callId) return;
        if (event.type === 'speech-started') {
          // An acoustic onset can be noise. Pause playback without consuming
          // the reply; only a finalized, nonempty utterance replaces its owner.
          if (!this.speechCandidate) {
            this.speechCandidate = true;
            this.player?.pause();
            log.info('reply held for possible speech', { callId, pendingInput: this.pendingInput });
            this.patch({ phase: 'listening', level: 0 });
          }
        } else if (event.type === 'speech-idle') {
          if (this.speechCandidate) {
            this.speechCandidate = false;
            this.player?.resume();
            log.info('reply resumed after empty speech', {
              callId,
              pendingInput: this.pendingInput,
            });
            this.setReplyPhase(this.replyPhase);
            this.updateMessages(this.latestMessages);
          }
        } else if (event.type === 'draft') {
          this.patch({ transcript: event.text });
        } else if (event.type === 'utterance') {
          this.queued.push(event.text);
          if (this.queued.join(' ').length > 16_000) this.fail('send');
          else void this.drain(epoch);
        } else if (event.type === 'ended') {
          this.end();
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
      const mic = this.deps.microphone(() => {
        if (current()) this.fail('microphone');
      });
      this.microphone = mic;
      mic.onPcm16k(({ pcm16k }) => {
        if (!current() || !this.callId) return;
        this.deps.api.audio({ callId: this.callId, pcm: pcm16k });
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
      } catch {
        if (current()) this.fail('microphone');
        return;
      }
      if (!current()) {
        await mic.stop();
        return;
      }
      this.setReplyPhase(this.pendingInput ? 'thinking' : null);
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('connection');
    }
  }

  private setReplyPhase(phase: typeof this.replyPhase): void {
    this.replyPhase = phase;
    this.patch({ phase: this.speechCandidate ? 'listening' : (phase ?? 'listening'), level: 0 });
  }

  /** Explicit stop or a committed new utterance permanently relinquishes the old reply. */
  interrupt(reason: 'user_stop' | 'new_utterance' = 'user_stop'): void {
    log.info('reply interrupted', { callId: this.callId, reason, pendingInput: this.pendingInput });
    ++this.speechEpoch;
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
  }

  private async submit(text: string, epoch: number): Promise<void> {
    const current = () =>
      this.enabled && epoch === this.epoch && !this.blocked && !this.state.muted;
    if (!current()) return;
    this.interrupt('new_utterance');
    this.setReplyPhase('thinking');
    this.patch({ transcript: '', unsent: '' });
    const replyEpoch = this.speechEpoch;
    let clientId: string | null = null;
    try {
      const accepted = await this.deps.send(
        text,
        (id) => {
          clientId = id;
        },
        current,
      );
      if (!current()) {
        // A permission/mute boundary can cancel preflight before enqueue. Wait
        // for its outcome before resuming, retaining only genuinely unsent text.
        if (!accepted && this.enabled)
          this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
        return;
      }
      if (!accepted || !clientId) {
        this.fail('send', text);
        return;
      }
      if (replyEpoch !== this.speechEpoch) return;
      log.info('voice input accepted', { callId: this.callId, clientId, characters: text.length });
      this.pendingInput = clientId;
      this.tracker.expect(clientId);
      this.updateMessages(this.latestMessages);
    } catch {
      if (current()) this.fail('send', text);
      else if (this.enabled)
        this.patch({ unsent: [text, this.state.unsent].filter(Boolean).join(' ') });
    }
  }

  private async drain(epoch: number): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queued.length && this.enabled && epoch === this.epoch && !this.blocked) {
        this.inFlight = this.submit(this.queued.shift()!, epoch);
        await this.inFlight;
      }
    } finally {
      this.sending = false;
      if (this.queued.length && this.callId && this.enabled && !this.blocked)
        void this.drain(this.epoch);
    }
  }

  updateMessages(messages: readonly ChatMessage[]): void {
    this.latestMessages = messages;
    if (
      !this.enabled ||
      !this.callId ||
      this.blocked ||
      this.state.muted ||
      !this.pendingInput ||
      this.speechCandidate
    )
      return;
    const reply = this.tracker.take(messages);
    if (!reply) {
      if (!this.tracker.hasPendingReply) {
        log.info('reply ownership superseded', {
          callId: this.callId,
          pendingInput: this.pendingInput,
        });
        this.pendingInput = null;
        this.setReplyPhase(null);
      }
      return;
    }
    this.pendingInput = null;
    log.info('final reply selected', {
      callId: this.callId,
      replyId: reply.id,
      characters: reply.text.length,
    });
    void this.speak(reply.text);
  }

  private async speak(text: string): Promise<void> {
    const epoch = this.epoch;
    const speechEpoch = ++this.speechEpoch;
    const callId = this.callId;
    const player = this.player;
    if (!callId || !player) return;
    const current = () =>
      epoch === this.epoch && speechEpoch === this.speechEpoch && this.enabled && !this.blocked;
    this.setReplyPhase('preparing');
    try {
      for (const [index, chunk] of speechChunks(text).entries()) {
        if (!current()) return;
        const requestId = `${speechEpoch}:${index}`;
        log.info('speech requested', { callId, requestId, characters: chunk.length });
        const { sampleRate } = await this.deps.api.speak({ callId, requestId, text: chunk });
        if (!current()) return;
        this.setReplyPhase('speaking');
        await player.play(
          () => this.deps.api.readSpeech(callId, requestId),
          sampleRate,
          () => {
            log.info('playback scheduled', { callId, requestId, sampleRate });
          },
        );
        if (current()) log.info('playback completed', { callId, requestId });
      }
      if (current()) this.setReplyPhase(null);
    } catch {
      if (current()) this.fail('speech');
    }
  }

  finishUtterance(): void {
    const epoch = this.epoch;
    if (this.callId)
      void this.deps.api.finishUtterance(this.callId).catch(() => {
        if (epoch === this.epoch) this.fail('connection');
      });
  }

  setBlocked(blocked: boolean): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    if (blocked && this.enabled) {
      const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
        .filter(Boolean)
        .join(' ');
      this.release();
      this.patch({ phase: 'paused', unsent, transcript: '', level: 0 });
    }
    // Confirmation completion does not silently restart a microphone.
  }

  toggleMute(): void {
    if (this.state.muted) {
      if (this.selection) void this.start(this.selection);
      return;
    }
    const unsent = [this.state.unsent, ...this.queued, this.state.transcript]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({ muted: true, phase: 'paused', transcript: '', unsent, level: 0 });
  }

  retryUnsent(): void {
    if (!this.state.unsent || !this.callId || this.blocked) return;
    const text = this.state.unsent;
    this.queued.push(text);
    void this.drain(this.epoch);
  }

  private fail(error: VoiceSnapshot['error'], text?: string): void {
    log.warn('voice mode failed', { callId: this.callId, phase: this.state.phase, reason: error });
    const unsent = [text || this.state.transcript || this.state.unsent, ...this.queued]
      .filter(Boolean)
      .join(' ');
    this.release();
    this.patch({ phase: 'error', error, unsent, transcript: '', level: 0 });
  }

  private release(): void {
    ++this.epoch;
    ++this.speechEpoch;
    this.speechCandidate = false;
    this.replyPhase = null;
    this.queued = [];
    const callId = this.callId;
    const microphone = this.microphone;
    this.callId = null;
    this.microphone = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.player?.close();
    this.player = null;
    this.teardown = Promise.allSettled([
      this.teardown,
      this.pendingStart,
      this.inFlight,
      microphone?.stop(),
      callId ? this.deps.api.end(callId) : undefined,
    ]);
  }

  end(): void {
    this.enabled = false;
    this.release();
    this.tracker.interrupt();
    this.pendingInput = null;
    this.patch({ phase: 'idle', transcript: '', level: 0, muted: false });
  }
}
