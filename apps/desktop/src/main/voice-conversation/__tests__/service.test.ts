import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrSegment } from '@cindy/voice-input-core';
import { VoiceConversationService } from '../service.js';
import { hasVoiceConversationLease } from '../lease.js';

const active: VoiceConversationService[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((service) => service.end(1)));
  vi.useRealTimers();
});

const previewSelection = {
  previewId: 'preview-1',
  botId: 'bot',
  sessionId: 'canonical',
  modelId: 'tts',
  voice: 'alloy',
  text: 'voice sample',
};
describe('voice preview ownership', () => {
  it('synthesizes the exact selection without allocating ASR, and excludes concurrent calls', async () => {
    const { service, deps } = fixture();
    expect(await service.startPreview(1, previewSelection)).toEqual({ sampleRate: 24000 });
    expect(deps.assertCompanion).toHaveBeenCalledWith('bot', 'canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledWith(
      new URL('https://gateway.test/v1/audio/speech'),
      expect.objectContaining({
        body: JSON.stringify({
          model: 'tts',
          voice: 'alloy',
          input: 'voice sample',
          response_format: 'pcm',
        }),
      }),
    );
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    await expect(service.readPreview(2, 'preview-1')).rejects.toThrow('preview_ended');
    service.stopPreview(2, 'preview-1');
    expect(hasVoiceConversationLease()).toBe(true);
    expect((await service.readPreview(1, 'preview-1')).pcm.byteLength).toBe(2);
    service.stopPreview(1, 'preview-1');
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('cancels while companion authorization is pending without issuing a late paid request', async () => {
    const { service, deps } = fixture();
    let release!: () => void;
    deps.assertCompanion.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = service.startPreview(1, previewSelection);
    service.stopPreview(1, 'preview-1');
    release();
    await expect(pending).rejects.toThrow('preview_ended');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('checks eligibility and canonical ownership before preview execution', async () => {
    const { service, deps } = fixture();
    await expect(
      service.startPreview(1, { ...previewSelection, modelId: 'invented' }),
    ).rejects.toThrow('model_unavailable');
    deps.assertCompanion.mockRejectedValueOnce(new Error('not canonical'));
    await expect(service.startPreview(1, previewSelection)).rejects.toThrow('not canonical');
    deps.hasDictation.mockReturnValueOnce(true);
    await expect(service.startPreview(1, previewSelection)).rejects.toThrow('busy');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it.each(['owner', 'connection'] as const)('releases playback on a changed %s', async (change) => {
    const { service, deps } = fixture();
    await service.startPreview(1, previewSelection);
    if (change === 'owner') deps.owner.mockReturnValue('owner-b');
    else
      deps.connection.mockImplementation(() => {
        throw new Error('model_unavailable');
      });
    await expect(service.readPreview(1, 'preview-1')).rejects.toThrow();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('releases the lease on sender teardown and on the bounded preview deadline', async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    await service.startPreview(1, previewSelection);
    await service.end(1);
    expect(hasVoiceConversationLease()).toBe(false);
    await service.startPreview(1, previewSelection);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasVoiceConversationLease()).toBe(false);
  });
});
const selection = {
  callId: 'call-1',
  botId: 'bot',
  sessionId: 'canonical',
  modelId: 'tts',
  voice: 'alloy',
};
function fixture() {
  const provider = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    appendAudio: vi.fn(),
    flushAudio: vi.fn(async () => {}),
    onSegment: vi.fn<(callback: (segment: AsrSegment) => void) => void>(),
    onEvent: vi.fn(),
  };
  const deps = {
    owner: vi.fn(() => 'owner-a'),
    hasDictation: vi.fn(() => false),
    assertCompanion: vi.fn(async () => {}),
    models: vi.fn(() => [{ id: 'tts', name: 'Speech' }]),
    createProvider: vi.fn(async () => provider),
    connection: vi.fn(() => ({
      baseUrl: 'https://gateway.test/v1',
      protocol: 'openai' as const,
      headers: { authorization: 'Bearer test-key' },
    })),
    fetch: vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
    ),
    emit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const service = new VoiceConversationService(deps);
  active.push(service);
  return { service, deps, provider };
}

describe('local companion call ownership', () => {
  it('logs send timing and speech stages through the injected logger without content or credentials', async () => {
    vi.useFakeTimers();
    const { service, deps, provider } = fixture();
    await service.start(1, selection);
    provider.onSegment.mock.calls[0][0]({ id: 'segment', text: 'private utterance', final: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(deps.log.info).toHaveBeenCalledWith('input settled', {
      callId: selection.callId,
      trigger: 'silence',
      inactiveMs: 1_500,
      finalStableMs: 1_500,
      segments: 1,
      characters: 17,
    });
    await service.speak(1, selection.callId, 'request-1', 'private reply');
    await service.readSpeech(1, selection.callId, 'request-1');
    await service.readSpeech(1, selection.callId, 'request-1');
    expect(deps.log.info).toHaveBeenCalledWith(
      'speech transport',
      expect.objectContaining({
        callId: selection.callId,
        requestId: 'request-1',
        protocol: 'openai',
        stage: 'complete',
        bytes: 2,
      }),
    );
    const logs = JSON.stringify([...deps.log.info.mock.calls, ...deps.log.warn.mock.calls]);
    for (const privateValue of [
      'private utterance',
      'private reply',
      'test-key',
      'gateway.test',
      'alloy',
    ])
      expect(logs).not.toContain(privateValue);
  });

  it('requires a real available speech model and the canonical companion task before allocating ASR', async () => {
    const { service, deps } = fixture();
    await expect(service.start(1, { ...selection, modelId: 'invented' })).rejects.toThrow(
      'model_unavailable',
    );
    deps.assertCompanion.mockRejectedValueOnce(new Error('not canonical'));
    await expect(service.start(1, selection)).rejects.toThrow('not canonical');
    expect(deps.createProvider).not.toHaveBeenCalled();
    expect(hasVoiceConversationLease()).toBe(false);
  });

  it('blocks concurrent dictation/calls and binds all operations to the initiating renderer', async () => {
    const { service, deps, provider } = fixture();
    deps.hasDictation.mockReturnValueOnce(true);
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    const { callId } = await service.start(1, selection);
    await expect(service.start(1, selection)).rejects.toThrow('busy');
    expect(() => service.audio(2, callId, new ArrayBuffer(2))).toThrow('call_ended');
    await service.end(2, callId);
    expect(provider.stop).not.toHaveBeenCalled();
    await service.end(1, callId);
    expect(provider.stop).toHaveBeenCalledOnce();
  });

  it('invalidates the old call and releases the microphone on account change', async () => {
    const { service, deps, provider } = fixture();
    const { callId } = await service.start(1, selection);
    deps.owner.mockReturnValue('owner-b');
    expect(() => service.audio(1, callId, new ArrayBuffer(2))).toThrow('call_ended');
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledOnce());
    expect(deps.emit).toHaveBeenCalledWith(1, { callId, event: { type: 'ended' } });
  });

  it('rechecks catalog eligibility before speech dispatch', async () => {
    const { service, deps } = fixture();
    const { callId } = await service.start(1, selection);
    deps.connection.mockImplementation(() => {
      throw new Error('model_unavailable');
    });
    await expect(service.speak(1, callId, 'request', 'hello')).rejects.toThrow('model_unavailable');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('cancels a pending provider allocation without starting a stale microphone session', async () => {
    const { service, deps, provider } = fixture();
    let resolve!: (value: typeof provider) => void;
    deps.createProvider.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const starting = service.start(1, selection);
    await vi.waitFor(() => expect(deps.createProvider).toHaveBeenCalledOnce());
    await service.end(1);
    resolve(provider);
    await expect(starting).rejects.toThrow('call_ended');
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.dispose).toHaveBeenCalledOnce();
  });
});

it('pins the selected connection and stops before sending to changed credentials or endpoints', async () => {
  const { service, deps } = fixture();
  await service.start(1, selection);
  deps.connection.mockReturnValue({
    baseUrl: 'https://changed.test/v1',
    protocol: 'openai',
    headers: { authorization: 'Bearer different-key' },
  });
  await expect(service.speak(1, selection.callId, 'req', 'private reply')).rejects.toThrow(
    'connection_changed',
  );
  expect(deps.fetch).not.toHaveBeenCalled();
});

it('cancels an existing body when credentials change before a PCM read', async () => {
  const { service, deps } = fixture();
  const cancelled = vi.fn();
  deps.fetch.mockImplementation(
    async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
        headers: { 'Content-Type': 'audio/pcm' },
      }),
  );
  await service.start(1, selection);
  await service.speak(1, selection.callId, 'req', 'hello');
  deps.connection.mockImplementation(() => {
    throw new Error('model_unavailable');
  });
  await expect(service.readSpeech(1, selection.callId, 'req')).rejects.toThrow('model_unavailable');
  expect(cancelled).toHaveBeenCalledOnce();
});
