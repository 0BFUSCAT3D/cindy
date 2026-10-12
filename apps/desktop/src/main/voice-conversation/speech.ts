import { miniMaxPcmStream, speechRequest, type SpeechConnection } from './speechProtocols.js';
import { SpeechError } from './speechError.js';
export type { SpeechConnection } from './speechProtocols.js';
/** PCM speech transport with provider adapters. Reads are pulled by playback for bounded buffering. */
export class SpeechSynthesisSession {
  private epoch = 0;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private requestId: string | null = null;
  private totalBytes = 0;
  private reading = false;

  constructor(
    private readonly deps: {
      connection(): SpeechConnection;
      assertCurrent(): void;
      fetch: typeof fetch;
    },
  ) {}

  async start(input: {
    requestId: string;
    modelId: string;
    voice: string;
    text: string;
  }): Promise<{ sampleRate: number }> {
    this.cancel();
    const epoch = this.epoch;
    this.deps.assertCurrent();
    const connection = this.deps.connection();
    const { url, body } = speechRequest(connection, input);
    const controller = new AbortController();
    this.controller = controller;
    this.requestId = input.requestId;
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response | undefined;
    try {
      response = await this.deps.fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { ...connection.headers, 'Content-Type': 'application/json' },
        body,
      });
      this.deps.assertCurrent();
      if (epoch !== this.epoch || controller.signal.aborted) {
        await response.body?.cancel();
        throw new SpeechError('cancelled');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new SpeechError('request');
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (
        !contentType ||
        !(
          connection.protocol === 'minimax'
            ? ['text/event-stream', 'application/json']
            : ['audio/pcm', 'audio/x-pcm', 'application/octet-stream']
        ).includes(contentType)
      ) {
        await response.body.cancel();
        throw new SpeechError('format');
      }
      this.reader = (
        connection.protocol === 'minimax' ? miniMaxPcmStream(response.body) : response.body
      ).getReader();
      // All three adapters request 24 kHz mono PCM; this is not inferred from model mode.
      return { sampleRate: 24_000 };
    } catch (error) {
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined);
      if (epoch === this.epoch) this.cancel();
      throw error instanceof SpeechError ? error : new SpeechError('request');
    } finally {
      clearTimeout(timer);
    }
  }

  async read(requestId: string): Promise<{ pcm: ArrayBuffer; done: boolean }> {
    try {
      this.deps.assertCurrent();
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (requestId !== this.requestId || !this.reader || this.reading)
      throw new SpeechError('cancelled');
    const reader = this.reader;
    const epoch = this.epoch;
    this.reading = true;
    const timer = setTimeout(() => {
      if (epoch === this.epoch) this.cancel();
    }, 15_000);
    try {
      const result = await reader.read();
      this.deps.assertCurrent();
      if (epoch !== this.epoch) throw new SpeechError('cancelled');
      const value = result.value ?? new Uint8Array();
      this.totalBytes += value.byteLength;
      if (value.byteLength > 1_048_576 || this.totalBytes > 24_000 * 2 * 600) {
        this.cancel();
        throw new SpeechError('format');
      }
      if (result.done) {
        if (this.totalBytes === 0 || this.totalBytes % 2 !== 0) throw new SpeechError('format');
        reader.releaseLock();
        this.reader = null;
        this.requestId = null;
      }
      return { pcm: Uint8Array.from(value).buffer, done: result.done };
    } catch (error) {
      if (epoch === this.epoch) this.cancel();
      throw error instanceof SpeechError ? error : new SpeechError('request');
    } finally {
      clearTimeout(timer);
      if (epoch === this.epoch) this.reading = false;
    }
  }

  cancel(): void {
    ++this.epoch;
    this.controller?.abort();
    this.controller = null;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.requestId = null;
    this.reading = false;
    this.totalBytes = 0;
  }
}
