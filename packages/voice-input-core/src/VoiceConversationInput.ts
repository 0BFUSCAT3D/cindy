import type { AsrEndpointing, AsrProvider, AsrSegment, AudioTrace } from "./types.js";
import { ConversationActivity } from "./conversationActivity.js";
import type { AudioGate } from "./SpeakerGate.js";

// Endpointing only: this input layer never ends voice mode for prolonged silence.
// The host owns idle/intent/lifecycle exits using task and playback activity too;
// ASR transport rotation is separate from that policy.
const AUTO_SEND_QUIET_MS = 1_250;
const FINAL_STABLE_MS = 350;

export type ConversationInputEvent =
  | { type: "ready" }
  | { type: "speech-started" }
  | { type: "speech-idle" }
  | { type: "draft"; text: string }
  | { type: "utterance"; id: string; text: string }
  | { type: "error"; text: string };

/**
 * Continuous ASR ownership and endpointing. Provider IDs, never string-prefix
 * subtraction, identify submitted speech. Connections rotate below the managed
 * service's default lifetime while capture is buffered; the product call lives on.
 */
export class VoiceConversationInput {
  private provider: AsrProvider | null = null;
  private generation = 0;
  private sequence = 0;
  private closed = false;
  private rotating = false;
  private activity = new ConversationActivity();
  private speaking = false;
  private manual = false;
  private segments = new Map<string, AsrSegment & {
    generation: number;
    // Global released-audio clock, surviving provider rotation.
    audioEndPositionMs?: number;
    textQuietAfter: number;
  }>();
  private consumed = new Set<string>();
  private pending: Array<{ pcm: ArrayBuffer; trace?: AudioTrace }> = [];
  private pendingBytes = 0;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private finalTimer?: ReturnType<typeof setTimeout>;
  private awaitingSettlement = false;
  private acousticQuietAfter = 0;
  private audioPositionMs = 0;
  private providerAudioMs = 0;
  private stableAfter = 0;
  private filteredQuietMs = 0;

  constructor(
    private readonly options: {
      createProvider: () => Promise<AsrProvider>;
      audioGate?: AudioGate;
      // Recheck ownership when asynchronously filtered audio is released.
      isCurrent?: () => boolean;
      emit: (event: ConversationInputEvent) => void;
      rotationMs?: number;
      // Numeric endpointing evidence only; the host owns logging and storage.
      diagnostic?: (event: {
        trigger: "manual" | "silence";
        inactiveMs: number;
        pauseBasis: "audio" | "text-fallback";
        endpointing: AsrEndpointing;
        endSignal: AsrEndpointing;
        finalStableMs: number | null;
        segments: number;
        characters: number;
        filteredQuietMs?: number;
      }) => void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.closed) return;
    // One gate per microphone run, not per ASR transport. Rotation must retain
    // held onsets and accepted short-phrase context. No second debounce here:
    // accepted audio immediately reaches activity detection and ASR together.
    this.options.audioGate?.begin((pcm, trace) =>
      this.forwardAudio(pcm, trace),
    );
    await this.open();
  }

  appendAudio(pcm: ArrayBuffer, trace?: AudioTrace): void {
    if (this.closed) return;
    if (this.options.audioGate) {
      this.options.audioGate.push(pcm, trace);
      return;
    }
    this.forwardAudio(pcm, trace);
  }

  private forwardAudio(pcm: ArrayBuffer, trace?: AudioTrace): void {
    if (this.closed || this.options.isCurrent?.() === false) return;
    this.audioPositionMs += pcm.byteLength / 32;
    const activity = this.activity.push(pcm);
    this.speaking = activity.active;
    // Wall-clock silence while the gate is still deciding a speaker is not a
    // pause. Require actual released quiet audio too, without adding another
    // 1.25s timer after it. Rejected speech arrives as silence from AudioGate.
    this.filteredQuietMs = activity.sound
      ? 0
      : Math.min(
          AUTO_SEND_QUIET_MS,
          this.filteredQuietMs + pcm.byteLength / 32,
        );
    // Acoustic silence and transcript stability have independent clocks. The
    // 900ms release commits manual ASR buffers, never submits a user message.
    if (activity.sound) {
      this.acousticQuietAfter = Date.now() + AUTO_SEND_QUIET_MS;
      if (!this.manual) clearTimeout(this.settleTimer);
    }
    if (activity.started) {
      this.awaitingSettlement = true;
      clearTimeout(this.finalTimer);
      if (!this.manual) clearTimeout(this.settleTimer);
      this.options.emit({ type: "speech-started" });
    }
    if (!this.provider || this.rotating) {
      this.pending.push({ pcm, trace });
      this.pendingBytes += pcm.byteLength;
      // Five seconds of 16 kHz PCM. Never silently discard a user's speech.
      if (this.pendingBytes > 160_000) this.fail();
      return;
    }
    this.appendToProvider(pcm, trace);
    if (activity.ended) this.finishUtterance();
    else if (!activity.active) this.scheduleSettlement();
  }

  private appendToProvider(pcm: ArrayBuffer, trace?: AudioTrace): void {
    this.providerAudioMs += pcm.byteLength / 32;
    this.provider?.appendAudio(pcm, trace);
  }

  finishUtterance(force = false): void {
    if (this.closed) return;
    this.manual ||= force;
    // Send commits the already recognized text. Do not finish()/bypass the
    // continuous gate: audio awaiting verification must still be judged.
    this.provider?.commitUtterance?.();
    this.scheduleSettlement();
    clearTimeout(this.finalTimer);
    this.finalTimer = setTimeout(() => {
      if (
        this.segments.size &&
        [...this.segments.values()].some((part) => !part.final)
      )
        this.fail();
    }, 8_000);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.audioGate?.abort();
    ++this.generation;
    clearTimeout(this.settleTimer);
    clearTimeout(this.rotationTimer);
    clearTimeout(this.finalTimer);
    this.pending = [];
    this.pendingBytes = 0;
    const provider = this.provider;
    this.provider = null;
    if (provider) {
      try {
        await provider.stop();
      } finally {
        await provider.dispose?.();
      }
    }
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    const provider = await this.options.createProvider();
    if (this.closed || generation !== this.generation) {
      await provider.stop();
      await provider.dispose?.();
      return;
    }
    this.provider = provider;
    const audioOffsetMs = this.audioPositionMs - this.pendingBytes / 32;
    this.providerAudioMs = 0;
    if (!provider.onSegment)
      throw new Error("Continuous transcription is unavailable.");
    provider.onSegment((segment) => {
      if (this.closed || generation !== this.generation) return;
      const key = `${generation}:${segment.id}`;
      if (this.consumed.has(key)) return;
      const prior = this.segments.get(key);
      if (prior?.final) return;
      this.awaitingSettlement = true;
      const text = segment.text.trim();
      // Only provider audio offsets can prove that delayed/revised text belongs
      // to speech whose quiet window has already elapsed. Without them, keep the
      // conservative text-arrival fallback for soft speech missed by local VAD.
      const audioEndPositionMs = segment.final
        && typeof segment.audioEndMs === "number"
        && Number.isFinite(segment.audioEndMs)
        && segment.audioEndMs >= 0
        && segment.audioEndMs <= this.providerAudioMs
        ? audioOffsetMs + segment.audioEndMs
        : undefined;
      const textQuietAfter = (text && text !== prior?.text.trim()) || !prior
        ? Date.now() + AUTO_SEND_QUIET_MS
        : prior.textQuietAfter;
      this.stableAfter = Date.now() + FINAL_STABLE_MS;
      if (!prior?.text && segment.text.trim() && !this.speaking)
        this.options.emit({ type: "speech-started" });
      this.segments.set(key, {
        ...segment, generation, audioEndPositionMs, textQuietAfter,
      });
      this.options.emit({ type: "draft", text: this.draft() });
      if (this.draft().length > 16_000) {
        this.fail();
        return;
      }
      this.scheduleSettlement();
    });
    provider.onEvent((event) => {
      if (this.closed || generation !== this.generation || this.rotating)
        return;
      if (event.type === "error" || event.type === "disconnected") this.fail();
    });
    await provider.start();
    if (this.closed || generation !== this.generation) return;
    this.rotating = false;
    const hadBufferedAudio = this.pending.length > 0;
    for (const chunk of this.pending.splice(0))
      this.appendToProvider(chunk.pcm, chunk.trace);
    this.pendingBytes = 0;
    if (hadBufferedAudio && !this.speaking) provider.commitUtterance?.();
    this.rotationTimer = setTimeout(() => {
      void this.rotate().catch(() => this.fail());
    }, this.options.rotationMs ?? 150_000);
    this.options.emit({ type: "ready" });
  }

  private draft(): string {
    return [...this.segments.values()]
      .sort(
        (a, b) =>
          a.generation - b.generation || (a.order ?? 0) - (b.order ?? 0),
      )
      .map((segment) => segment.text.trim())
      .join(" ")
      .trim();
  }

  private settlementWait(): number | null {
    if ((this.speaking && !this.manual) || this.rotating || !this.awaitingSettlement)
      return null;
    const segments = [...this.segments.values()];
    if (segments.some((segment) => !segment.final)) return null;
    if (this.manual) return 0;
    // No wall-clock timeout may stand in for audio still held by the speaker
    // filter or still needed to establish silence after ASR-only soft speech.
    if (this.options.audioGate && this.filteredQuietMs < AUTO_SEND_QUIET_MS)
      return null;
    if (segments.some((segment) => segment.audioEndPositionMs !== undefined
      && this.audioPositionMs - segment.audioEndPositionMs < AUTO_SEND_QUIET_MS))
      return null;
    const textQuietAfter = Math.max(0, ...segments
      .filter((segment) => segment.audioEndPositionMs === undefined)
      .map((segment) => segment.textQuietAfter));
    // Capability and boundary evidence are deliberately separate from `final`.
    // This phase keeps 1.25s even for a semantic-capable provider. Enabling eager
    // semantic endpointing requires a separately validated policy, not a flag.
    return Math.max(0, this.acousticQuietAfter - Date.now(),
      textQuietAfter - Date.now(), this.stableAfter - Date.now());
  }

  private scheduleSettlement(): void {
    clearTimeout(this.settleTimer);
    const wait = this.settlementWait();
    if (wait === null) return;
    this.settleTimer = setTimeout(
      () => {
        if (
          this.closed ||
          this.options.isCurrent?.() === false ||
          this.settlementWait() !== 0
        )
          return;
        const text = this.draft();
        const segments = [...this.segments.values()];
        const usesTextFallback = segments.some((segment) => segment.audioEndPositionMs === undefined);
        const endpointing = this.provider?.endpointing ?? "segment-final";
        const lastSegment = segments.at(-1);
        const inactivity = Math.min(
          this.acousticQuietAfter ? Date.now() - this.acousticQuietAfter + AUTO_SEND_QUIET_MS : Infinity,
          ...segments.map((segment) => segment.audioEndPositionMs !== undefined
            ? this.audioPositionMs - segment.audioEndPositionMs
            : Date.now() - segment.textQuietAfter + AUTO_SEND_QUIET_MS),
        );
        this.options.diagnostic?.({
          trigger: this.manual ? "manual" : "silence",
          inactiveMs: Number.isFinite(inactivity) ? Math.max(0, inactivity) : 0,
          pauseBasis: usesTextFallback ? "text-fallback" : "audio",
          endpointing,
          endSignal: lastSegment?.turnEnd === endpointing ? endpointing : "segment-final",
          finalStableMs: this.stableAfter
            ? Date.now() - this.stableAfter + FINAL_STABLE_MS
            : null,
          segments: this.segments.size,
          characters: text.length,
          ...(this.options.audioGate
            ? { filteredQuietMs: this.filteredQuietMs }
            : {}),
        });
        for (const key of this.segments.keys()) this.consumed.add(key);
        this.segments.clear();
        this.awaitingSettlement = false;
        this.acousticQuietAfter = 0;
        this.stableAfter = 0;
        this.manual = false;
        clearTimeout(this.finalTimer);
        if (text)
          this.options.emit({
            type: "utterance",
            id: String(++this.sequence),
            text,
          });
        this.options.emit({ type: "draft", text: "" });
        if (!text) this.options.emit({ type: "speech-idle" });
      },
      wait,
    );
  }

  private async rotate(): Promise<void> {
    if (this.closed || !this.provider) return;
    this.rotating = true;
    clearTimeout(this.settleTimer);
    const previous = this.provider;
    // Finalize the previous transport before accepting its last segments. New
    // audio is already buffered for the replacement, so boundaries cannot overlap.
    await previous.flushAudio();
    if (this.closed) return;
    if ([...this.segments.values()].some((segment) => !segment.final)) {
      this.fail();
      return;
    }
    ++this.generation;
    await previous.stop();
    await previous.dispose?.();
    this.provider = null;
    this.consumed.clear();
    await this.open();
    this.scheduleSettlement();
  }

  private fail(): void {
    if (this.closed) return;
    this.options.emit({ type: "error", text: this.draft() });
    void this.stop().catch(() => undefined);
  }
}
