import {
  BUNDLED_CATALOG,
  buildUserProvider,
  findBaseModel,
  type AgentKind,
  type CustomProviderConfig,
  type ModelMetadata,
  type ProviderPreset,
  type ProviderRuntimeModelConfig,
  type ProviderView,
} from '@cindy/model-providers';

export type SpeechService = 'minimax' | 'elevenlabs' | 'openai' | 'bailian';

/** Onboarding references only: no account entitlement or synthesis probe is implied. */
const references: Record<SpeechService, string[]> = {
  minimax: ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-02-turbo'],
  elevenlabs: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'],
  openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  bailian: ['cosyvoice-v3-flash', 'qwen3-tts-flash', 'cosyvoice-v3-plus'],
};

export function speechServiceForUrl(value: string): SpeechService | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const path = url.pathname.replace(/\/+$/, '');
    if (
      [
        'api.minimax.io',
        'api.minimax.cn',
        'api.minimaxi.com',
        'api.minimax.chat',
        'api-uw.minimax.io',
      ].includes(url.hostname) &&
      ['', '/v1', '/anthropic'].includes(path)
    )
      return 'minimax';
    if (url.hostname === 'api.elevenlabs.io' && ['', '/v1'].includes(path)) return 'elevenlabs';
    if (url.hostname === 'api.openai.com' && ['', '/v1'].includes(path)) return 'openai';
    if (
      ([
        'dashscope.aliyuncs.com',
        'dashscope-intl.aliyuncs.com',
        'dashscope-us.aliyuncs.com',
      ].includes(url.hostname) ||
        /^ws-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname)) &&
      ['/api/v1', '/compatible-mode/v1'].includes(path)
    )
      return 'bailian';
  } catch {
    /* Invalid/unrecognized endpoints keep the manual connection flow. */
  }
}

export function isSpeechModel(model: {
  id: string;
  mode?: string;
  discoveredMetadata?: ModelMetadata;
}): boolean {
  return (
    (model.mode ??
      model.discoveredMetadata?.mode ??
      findBaseModel(BUNDLED_CATALOG.modelRegistry, model.id)?.defaults.mode) === 'audio_speech'
  );
}

export function speechReferenceModels(service: SpeechService): ProviderRuntimeModelConfig[] {
  // Names/capabilities remain owned by the shared Registry. This list only orders
  // a few setup suggestions; adding one is an explicit user membership decision.
  return references[service].flatMap((id, index) => {
    const base = findBaseModel(BUNDLED_CATALOG.modelRegistry, id);
    return base?.defaults.mode === 'audio_speech'
      ? [{ id, name: base.defaults.name ?? id, defaultEnabled: index === 0 }]
      : [];
  });
}

export function speechSetupTarget(runtimes: ProviderPreset['runtimes']) {
  for (const agent of ['codex', 'pi', 'claude-code'] as const) {
    const runtime = runtimes[agent];
    const service = runtime && speechServiceForUrl(runtime.baseUrl);
    if (service) return { agent, service };
  }
}

/** These are local connection forms, like OFFICIAL_API_PRESETS, not Registry entries. */
export const SPEECH_API_PRESETS: ProviderPreset[] = [
  {
    id: 'elevenlabs-api',
    name: 'ElevenLabs',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    runtimes: {
      codex: { baseUrl: 'https://api.elevenlabs.io/v1', wireProtocol: 'openai-chat', models: [] },
    },
  },
  ...(['global', 'cn'] as const).map((region): ProviderPreset => ({
    id: `aliyun-bailian-api-${region}`,
    name: region === 'cn' ? '阿里云百炼 API（中国大陆）' : '阿里云百炼 API',
    nameEn:
      region === 'cn'
        ? 'Alibaba Cloud Model Studio API (Mainland China)'
        : 'Alibaba Cloud Model Studio API',
    nameZhTW: region === 'cn' ? '阿里雲百煉 API（中國大陸）' : '阿里雲百煉 API',
    regionHint: region,
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
    runtimes: {
      codex: {
        baseUrl: `https://${region === 'cn' ? 'dashscope' : 'dashscope-intl'}.aliyuncs.com/compatible-mode/v1`,
        wireProtocol: 'openai-chat',
        baseUrlEditable: true,
        models: [{ id: 'qwen-plus', name: 'Qwen Plus' }],
      },
    },
  })),
];

export function withSpeechApiPresets(presets: ProviderPreset[]): ProviderPreset[] {
  return [
    ...presets,
    ...SPEECH_API_PRESETS.filter((fallback) => {
      const target = speechSetupTarget(fallback.runtimes)!;
      const origin = new URL(fallback.runtimes[target.agent]!.baseUrl).origin;
      return !presets.some((existing) => {
        if (existing.id === fallback.id) return true;
        // Prefer the server's official connection form even when it has a newer ID.
        // Coding/Token Plan endpoints are distinct and must not suppress API access.
        const existingTarget = speechSetupTarget(existing.runtimes);
        return (
          existingTarget?.service === target.service &&
          new URL(existing.runtimes[existingTarget.agent]!.baseUrl).origin === origin
        );
      });
    }),
  ];
}

export function providerSpeechSetup(
  provider: ProviderView,
):
  { agent: AgentKind; service: SpeechService; needsApiKey: boolean; presetId: string } | undefined {
  if (provider.source === 'organization' || provider.suspended) return;
  for (const agent of ['codex', 'pi', 'claude-code'] as const) {
    const upstream = provider.routing[agent]?.upstream;
    const service = upstream && speechServiceForUrl(upstream);
    if (!service) continue;
    if (provider.auth.method === 'apiKey' && provider.source !== 'user') continue;
    if (!['apiKey', 'oauth'].includes(provider.auth.method)) continue;
    return {
      agent,
      service,
      needsApiKey: provider.auth.method === 'oauth',
      presetId:
        service === 'minimax'
          ? ['api.minimax.io', 'api-uw.minimax.io'].includes(new URL(upstream!).hostname)
            ? 'minimax-global'
            : 'minimax-cn'
          : service === 'bailian'
            ? upstream!.includes('dashscope-intl')
              ? 'aliyun-bailian-api-global'
              : 'aliyun-bailian-api-cn'
            : `${service}-api`,
    };
  }
  // Native OpenAI subscription endpoints are deliberately different from its API.
  if (provider.id === 'openai' || provider.auth.native === 'codex')
    return { agent: 'codex', service: 'openai', needsApiKey: true, presetId: 'openai-api' };
}

/** Merge under Main's mutation queue, preserving concurrent edits and all existing models. */
export function appendSpeechModels(
  current: CustomProviderConfig,
  request: CustomProviderConfig,
): CustomProviderConfig {
  if ((current.auth?.method ?? 'apiKey') !== 'apiKey')
    throw new Error('api_key_connection_required');
  const next = structuredClone(current);
  // The catalog omits an explicit runtime protocol when it equals the engine default.
  // Compare the same projection, while keeping the original stored declaration intact.
  const currentRouting = buildUserProvider(current).routing;
  const requestedRouting = buildUserProvider(request).routing;
  const known = new Set(
    Object.values(next.runtimes).flatMap(
      (runtime) => runtime?.models.map((model) => model.id) ?? [],
    ),
  );
  for (const [key, draft] of Object.entries(request.runtimes)) {
    const agent = key as AgentKind;
    const runtime = next.runtimes[agent];
    if (
      !draft ||
      !runtime ||
      runtime.baseUrl !== draft.baseUrl ||
      currentRouting[agent]?.wireProtocol !== requestedRouting[agent]?.wireProtocol ||
      runtime.requestPath !== draft.requestPath ||
      runtime.modelsUrl !== draft.modelsUrl
    )
      throw new Error('connection_changed');
    for (const model of draft.models) {
      if (!isSpeechModel(model)) throw new Error('speech_model_required');
      if (known.has(model.id)) continue;
      runtime.models.push(structuredClone(model));
      known.add(model.id);
    }
  }
  return next;
}
