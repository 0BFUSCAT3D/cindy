import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import { isAgentSelectableModel } from '../classification.js';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels, pickModelMetadata, validModelMetadata } from '../modelMetadataLayers.js';
import { resolveCatalogModelNativeApi, resolveModelNativeApi } from '../modelRegistry.js';
import { buildUserProvider } from '../user-provider.js';
import type { ModelRegistry } from '../modelAccessBean.js';
import type { ProviderRuntimeModelConfig } from '../types.js';

const registry = BUNDLED_CATALOG.modelRegistry!;
function provider(models: ProviderRuntimeModelConfig[], id = 'speech-account') {
  return buildUserProvider({ id, name: id, runtimes: {
    codex: { baseUrl: 'https://speech.example.test/v1', wireProtocol: 'openai-chat', models },
  } }, { modelRegistry: registry });
}

describe('BYOK speech discovery and projection', () => {
  it.each(['nativeApi', 'native_api'])('retains explicit speech metadata from %s through refresh and catalog parsing', key => {
    const discovered = parseModelsListResponse({ data: [{ id: 'custom-voice',
      name: 'Custom Voice', mode: 'audio_speech', [key]: 'openai-audio-speech',
    }] })!;
    expect(discovered[0].discoveredMetadata).toMatchObject({ mode: 'audio_speech', nativeApi: 'openai-audio-speech' });
    const models = mergeDiscoveredRuntimeModels([], discovered);
    const p = provider(mergeDiscoveredRuntimeModels(models, [{ id: 'custom-voice', name: 'Custom Voice' }]));
    expect(p.audioModels).toEqual([expect.objectContaining({ id: 'custom-voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech', sourceAgent: 'codex' })]);
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    expect(parseCatalog({ ...BUNDLED_CATALOG, providers: [p] }).providers[0].audioModels).toEqual(p.audioModels);
  });

  it('accepts model_id without inferring a capability or protocol from a vendor name', () => {
    const result = parseModelsListResponse({ models: [
      { model_id: 'voice-v1', name: 'Voice', model_info: { mode: 'audio_speech' } },
      { model_id: 'private-tts-v1', name: 'Unknown model' },
    ] })!;
    expect(result.map(m => m.id)).toEqual(['voice-v1', 'private-tts-v1']);
    const p = provider(mergeDiscoveredRuntimeModels([], result));
    expect(p.audioModels?.map(m => m.id)).toEqual(['voice-v1']);
    expect(p.audioModels?.[0].nativeApi).toBeUndefined();
    expect(isAgentSelectableModel(p.models.codex![1], { userProvider: true })).toBe(true);
  });

  it('uses exact public identity for ID-only discovery without inventing account members or a speech protocol', () => {
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [
      { id: 'gpt-4o-mini-tts' }, { id: 'gpt-6-astra' },
    ] })!);
    const p = provider(models);
    expect(p.audioModels?.map(m => m.id)).toEqual(['gpt-4o-mini-tts']);
    expect(p.audioModels?.[0].nativeApi).toBeUndefined();
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    expect(isAgentSelectableModel(p.models.codex![1], { userProvider: true })).toBe(true);
    expect(p.models.codex![1].nativeApi).toBe('openai-responses');
    expect(provider([]).audioModels).toBeUndefined();
  });

  it('preserves manual type, name and visibility overrides across conflicting discovery', () => {
    const original: ProviderRuntimeModelConfig[] = [{ id: 'gpt-private', name: 'My Voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech', defaultEnabled: false }];
    const merged = mergeDiscoveredRuntimeModels(original, parseModelsListResponse({ data: [
      { id: 'gpt-private', name: 'Upstream', mode: 'chat', nativeApi: 'openai-responses' },
    ] })!);
    expect(merged[0]).toMatchObject(original[0]);
    const p = provider(merged);
    expect(p.audioModels?.[0]).toMatchObject({ id: 'gpt-private', name: 'My Voice',
      mode: 'audio_speech', nativeApi: 'openai-audio-speech' });
    expect(p.models.codex![0].defaultEnabled).toBe(false);
    expect(isAgentSelectableModel(p.models.codex![0], { userProvider: true })).toBe(false);
    const inherited = provider([{ ...merged[0], mode: undefined, nativeApi: undefined }]);
    expect(inherited.audioModels).toBeUndefined();
    expect(inherited.models.codex![0].mode).toBe('chat');
  });

  it('keeps same-ID models scoped to each connection', () => {
    const speech = provider([{ id: 'same-id', name: 'Speech', mode: 'audio_speech' }], 'speech');
    const chat = provider([{ id: 'same-id', name: 'Chat', mode: 'chat' }], 'chat');
    expect(speech.id).not.toBe(chat.id);
    expect(speech.audioModels?.[0].name).toBe('Speech');
    expect(chat.audioModels).toBeUndefined();
    expect(chat.models.codex![0].mode).toBe('chat');
  });
});

describe('media native API metadata', () => {
  it('preserves known media protocols and explicit unknown, and rejects arbitrary protocols', () => {
    expect(validModelMetadata({ nativeApi: 'openai-audio-speech' })).toBe(true);
    expect(pickModelMetadata({ nativeApi: null })).toEqual({ nativeApi: null });
    expect(pickModelMetadata({ nativeApi: 'unimplemented-vendor-protocol' })).toEqual({});
  });

  it.each(['gpt-4o-mini-tts', 'openai/gpt-4o-mini-tts'])(
    'does not assign a chat family protocol to the public speech model %s', id => {
      expect(resolveCatalogModelNativeApi(registry, id)).toBeUndefined();
      expect(resolveModelNativeApi(registry, 'xd', id)).toBeUndefined();
    },
  );

  it('uses explicit media mode ahead of chat prefix rules, keeping exact declarations authoritative', () => {
    const r: ModelRegistry = { schemaVersion: 4, updatedAt: '2026-10-12T00:00:00.000Z', models: [],
      nativeApiRules: [{ providerId: 'xd', modelIdPrefix: 'gpt-', nativeApi: 'openai-responses' }] };
    expect(resolveCatalogModelNativeApi(r, 'gpt-private', 'audio_speech')).toBeUndefined();
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private', 'audio_speech')).toBeUndefined();
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private', 'chat')).toBe('openai-responses');
    r.models.push({ id: 'gpt-private', name: 'Speech', mode: 'audio_speech', nativeApi: 'openai-audio-speech',
      routes: [{ providerId: 'xd', modelId: 'gpt-private', agents: [] }] });
    expect(resolveCatalogModelNativeApi(r, 'gpt-private')).toBe('openai-audio-speech');
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private')).toBe('openai-audio-speech');
    r.models[0].nativeApi = null;
    expect(resolveModelNativeApi(r, 'xd', 'gpt-private')).toBeNull();
  });

  it('honors a catalog entry type even when it has no Gateway route or public base model', () => {
    const r: ModelRegistry = { schemaVersion: 4, updatedAt: '2026-10-12T00:00:00.000Z',
      models: [{ id: 'gpt-private-voice', name: 'Speech', mode: 'audio_speech', routes: [] }],
      nativeApiRules: [{ providerId: 'xd', modelIdPrefix: 'openai/gpt-', nativeApi: 'openai-responses' }],
    };
    expect(resolveCatalogModelNativeApi(r, 'gpt-private-voice')).toBeUndefined();
    expect(resolveCatalogModelNativeApi(r, 'gpt-private-chat')).toBe('openai-responses');
  });
});
