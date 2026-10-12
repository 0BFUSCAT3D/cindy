import { VoiceConversationInput, type AsrProvider, type AudioTrace } from '@cindy/voice-input-core';
import {
  voiceModelKey,
  type SpeechModelSelection,
  type SpeechPreviewStart,
  type SpeechVoiceCatalog,
} from '../../shared/voiceConversation.js';
import type {
  VoiceConversationEvent,
  VoiceConversationModel,
  VoiceConversationStart,
} from '../../shared/voiceConversation.js';
import { acquireVoiceConversationLease, releaseVoiceConversationLease } from './lease.js';
import { SpeechSynthesisSession, type SpeechConnection } from './speech.js';
import { loadSpeechVoices } from './voices.js';

type Call = {
  id: string;
  sender: number;
  owner: string;
  input: VoiceConversationInput;
  speech: SpeechSynthesisSession;
  selection: VoiceConversationStart;
};
type Preview = {
  id: string;
  sender: number;
  owner: string;
  speech: SpeechSynthesisSession;
  timer?: ReturnType<typeof setTimeout>;
};

/** One local call owns the microphone. Cancellation invalidates all pending starts and audio reads. */
export class VoiceConversationService {
  private call: Call | null = null;
  private preview: Preview | null = null;

  constructor(
    private readonly deps: {
      owner(): string;
      hasDictation(): boolean;
      assertCompanion(botId: string, sessionId: string): Promise<void>;
      models(): VoiceConversationModel[];
      createProvider(): Promise<AsrProvider>;
      connection(selection: SpeechModelSelection): SpeechConnection;
      fetch: typeof fetch;
      emit(sender: number, event: VoiceConversationEvent): void;
    },
  ) {}

  models(): VoiceConversationModel[] {
    return this.deps.models();
  }

  async voices(selection: SpeechModelSelection): Promise<SpeechVoiceCatalog> {
    const owner = this.deps.owner();
    const connection = this.deps.connection(selection);
    const identity = JSON.stringify(connection);
    return loadSpeechVoices(connection, selection.modelId, this.deps.fetch, () => {
      if (
        this.deps.owner() !== owner ||
        JSON.stringify(this.deps.connection(selection)) !== identity
      )
        throw new Error('connection_changed');
    });
  }

  /** Preview uses the exact synthesis adapter without starting ASR or submitting a task. */
  async startPreview(
    sender: number,
    selection: SpeechPreviewStart,
  ): Promise<{ sampleRate: number }> {
    if (this.call || this.preview || this.deps.hasDictation()) throw new Error('busy');
    if (!this.models().some((model) => voiceModelKey(model) === voiceModelKey(selection)))
      throw new Error('model_unavailable');
    const binding = this.deps.connection(selection);
    const identity = JSON.stringify(binding);
    const owner = this.deps.owner();
    if (!acquireVoiceConversationLease(selection.previewId)) throw new Error('busy');
    const preview: Preview = {
      id: selection.previewId,
      sender,
      owner,
      speech: new SpeechSynthesisSession({
        connection: () => binding,
        fetch: this.deps.fetch,
        assertCurrent: () => {
          if (
            this.preview !== preview ||
            this.deps.owner() !== owner ||
            JSON.stringify(this.deps.connection(selection)) !== identity
          )
            throw new Error('preview_ended');
        },
      }),
    };
    this.preview = preview;
    // A crashed/hidden renderer must not retain the global voice lease indefinitely.
    preview.timer = setTimeout(() => this.stopPreview(sender, preview.id), 60_000);
    try {
      await this.deps.assertCompanion(selection.botId, selection.sessionId);
      return await preview.speech.start({
        requestId: preview.id,
        modelId: selection.modelId,
        voice: selection.voice,
        text: selection.text,
      });
    } catch (error) {
      if (this.preview === preview) this.stopPreview(sender, preview.id);
      throw error;
    }
  }

  async readPreview(sender: number, id: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    const preview = this.preview;
    if (!preview || preview.sender !== sender || preview.id !== id)
      throw new Error('preview_ended');
    try {
      if (preview.owner !== this.deps.owner()) throw new Error('preview_ended');
      return await preview.speech.read(id);
    } catch (error) {
      if (this.preview === preview) this.stopPreview(sender, id);
      throw error;
    }
  }

  stopPreview(sender: number, id?: string): void {
    const preview = this.preview;
    if (!preview || preview.sender !== sender || (id && preview.id !== id)) return;
    this.preview = null;
    clearTimeout(preview.timer);
    preview.speech.cancel();
    releaseVoiceConversationLease(preview.id);
  }

  async start(sender: number, selection: VoiceConversationStart): Promise<{ callId: string }> {
    if (this.call || this.preview || this.deps.hasDictation()) throw new Error('busy');
    if (!this.models().some((model) => voiceModelKey(model) === voiceModelKey(selection)))
      throw new Error('model_unavailable');
    const binding = this.deps.connection(selection);
    const bindingIdentity = JSON.stringify(binding);
    const id = selection.callId;
    const owner = this.deps.owner();
    if (!acquireVoiceConversationLease(id)) throw new Error('busy');
    const assertCurrent = (): void => {
      if (this.call?.id !== id || this.deps.owner() !== owner) throw new Error('call_ended');
    };
    const input = new VoiceConversationInput({
      createProvider: async () => {
        assertCurrent();
        return this.deps.createProvider();
      },
      emit: (event) => {
        if (this.call?.id !== id) return;
        if (this.deps.owner() !== owner) {
          void this.end(sender, id);
          return;
        }
        this.deps.emit(sender, { callId: id, event });
        if (event.type === 'error') void this.end(sender, id);
      },
    });
    const speech = new SpeechSynthesisSession({
      connection: () => binding,
      fetch: this.deps.fetch,
      assertCurrent: () => {
        assertCurrent();
        // Resolving the selected binding rechecks its current catalog, route and key.
        if (JSON.stringify(this.deps.connection(selection)) !== bindingIdentity)
          throw new Error('connection_changed');
      },
    });
    this.call = { id, owner, sender, selection, input, speech };
    try {
      await this.deps.assertCompanion(selection.botId, selection.sessionId);
      assertCurrent();
      await input.start();
      assertCurrent();
      return { callId: id };
    } catch (error) {
      await this.end(sender, id);
      throw error;
    }
  }

  audio(sender: number, id: string, pcm: ArrayBuffer, trace?: AudioTrace): void {
    this.requireCall(sender, id).input.appendAudio(pcm, trace);
  }

  finishUtterance(sender: number, id: string): void {
    this.requireCall(sender, id).input.finishUtterance(true);
  }

  async speak(
    sender: number,
    id: string,
    requestId: string,
    text: string,
  ): Promise<{ sampleRate: number }> {
    const call = this.requireCall(sender, id);
    return call.speech.start({
      requestId,
      text,
      modelId: call.selection.modelId,
      voice: call.selection.voice,
    });
  }

  readSpeech(
    sender: number,
    id: string,
    requestId: string,
  ): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    return this.requireCall(sender, id).speech.read(requestId);
  }

  interrupt(sender: number, id: string): void {
    this.requireCall(sender, id).speech.cancel();
  }

  async end(sender: number, id?: string): Promise<void> {
    if (!id) this.stopPreview(sender);
    const call = this.call;
    if (!call || call.sender !== sender || (id && call.id !== id)) return;
    this.call = null;
    this.deps.emit(call.sender, { callId: call.id, event: { type: 'ended' } });
    call.speech.cancel();
    try {
      await call.input.stop();
    } catch {
      /* Ownership release must survive provider teardown. */
    } finally {
      releaseVoiceConversationLease(call.id);
    }
  }

  private requireCall(sender: number, id: string): Call {
    const call = this.call;
    if (!call || call.sender !== sender || call.id !== id) throw new Error('call_ended');
    if (call.owner !== this.deps.owner()) {
      void this.end(sender, id);
      throw new Error('call_ended');
    }
    return call;
  }
}
