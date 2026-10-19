import { describe, it, expect } from 'vitest';
import { BUNDLED_CATALOG, sortPresetsForRegion } from '../index.js';
import { bindDetectedProvider, classifyProviderAddress, detectDeploymentProviders, enrichDetectedModels, matchOfficialProviders, providerDeploymentRoot, type ProviderEvidence } from '../providerDetection.js';
// Contract: scheme 2 identifies configurations from combined evidence, never a port/model name.
// New production entry; previous catalog tests cover parsing, not identity/binding. Unit, no network.
const presets = BUNDLED_CATALOG.presets ?? [];
const models = { data: [{ id: 'alias', root: 'weights', owned_by: 'vllm', max_model_len: 8192 }] };
const evidence: ProviderEvidence = {
  subPublic: { code: 0, data: { version: '0.2.17', hide_ccs_import_button: false, backend_mode_enabled: true, subscription_enabled: false } },
  subBilling: { object: 'sub2api.key_billing', schema_version: 1 },
  liteReady: { litellm_version: '1.106.0', status: 'healthy', success_callbacks: [] },
  liteModels: { data: [{ model_name: 'alias', litellm_params: {}, model_info: {} }] },
  lmGreeting: { lmstudio: true }, lmModels: { models: [] },
  llamaProps: { default_generation_settings: {}, total_slots: 1, build_info: 'b11723' },
  vllmVersion: { version: '0.0.0+source.test' }, models,
};

describe('deployment evidence', () => {
  it.each([
    ['sub2api', ['subPublic', 'subBilling']], ['litellm', ['liteReady', 'liteModels']],
    ['lmstudio', ['lmGreeting', 'lmModels']], ['llamacpp', ['llamaProps', 'models']], ['vllm', ['vllmVersion', 'models']],
  ] as const)('requires combined evidence for %s', (id, keys) => {
    const input = Object.fromEntries(keys.map(k => [k, evidence[k]]));
    expect(detectDeploymentProviders(input)).toEqual([id]);
    for (const key of keys) expect(detectDeploymentProviders({ [key]: evidence[key] })).toEqual([]);
  });
  it('retains contradictory matches instead of choosing the first response', () => {
    expect(detectDeploymentProviders(evidence)).toEqual(['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm']);
  });
  it('rejects error bodies and coerced number/boolean fields', () => {
    expect(detectDeploymentProviders({ ...evidence, subPublic: { code: false, data: (evidence.subPublic as any).data }, subBilling: { object: 'sub2api.key_billing', schema_version: true },
      liteReady: { status: 'healthy' }, lmModels: { error: 'not found' }, llamaProps: { default_generation_settings: {}, total_slots: '1', build_info: 'x' }, models: { data: [{ id: 'alias', root: 'x', owned_by: 'vllm', max_model_len: true }] },
    })).toEqual([]);
  });
  it('accepts a nonempty native LM directory without the greeting, and rejects unknown types', () => {
    const native = { key: 'weights', type: 'embedding', publisher: 'test', loaded_instances: [] };
    expect(detectDeploymentProviders({ lmModels: { models: [native] } })).toEqual(['lmstudio']);
    expect(detectDeploymentProviders({ lmModels: { models: [{ ...native, type: 'unknown' }] } })).toEqual([]);
  });
  it('does not turn internal aliases into account-visible membership or maximize conflicting capabilities', () => {
    const result = enrichDetectedModels([{ id: 'public-alias', name: 'Alias' }], 'litellm', { liteModels: { data: [
      { model_name: 'public-alias', model_info: { id: 'deployment-1', max_input_tokens: 8192 } },
      { model_name: 'public-alias', model_info: { id: 'deployment-2', max_input_tokens: 32768 } },
      { model_name: 'hidden', model_info: {} },
    ] } });
    expect(result.map(m => m.id)).toEqual(['public-alias']);
    expect(result[0].discoveredMetadata?.contextWindow).toBeUndefined();
  });
  it('maps LM loaded instance aliases while retaining embedding type', () => {
    const result = enrichDetectedModels([{ id: 'friendly', name: 'Friendly' }], 'lmstudio', { lmModels: { models: [
      { key: 'file-name', type: 'embedding', publisher: 'test', loaded_instances: [{ id: 'friendly' }] },
    ] } });
    expect(result[0]).toMatchObject({ id: 'friendly', discoveredMetadata: { mode: 'embedding' } });
  });
});

describe('catalog mapping independent of desktop platform', () => {
  it.each(['cn', 'global'] as const)('classifies the entire active catalog without region filtering: %s', region => {
    expect(presets.length).toBeGreaterThan(28);
    for (const p of sortPresetsForRegion(presets, region)) {
      expect(['deployment', 'resource-template', 'official', 'manual']).toContain(classifyProviderAddress(p));
      if (classifyProviderAddress(p) !== 'official') continue;
      for (const runtime of Object.values(p.runtimes)) {
        if (runtime) expect(matchOfficialProviders(runtime.baseUrl, presets).map(p => p.id)).toContain(p.id);
      }
    }
  });
  it('matches exact official origin and business path, preserving multi-plan candidates', () => {
    const original = presets.find(p => p.id === 'deepseek')!;
    const url = original.runtimes.pi!.baseUrl;
    expect(matchOfficialProviders(url, [original, { ...original, id: 'same-address-plan' }])).toHaveLength(2);
    expect(matchOfficialProviders(url.replace('api.deepseek.com', 'api.deepseek.com.evil.test'), presets)).toEqual([]);
    expect(matchOfficialProviders(url + '/unregistered', presets)).toEqual([]);
    expect(matchOfficialProviders(url + '?token=fake', presets)).toEqual([]);
  });
  it('never identifies loopback ports or the generic endpoint template as a brand', () => {
    expect(matchOfficialProviders('http://127.0.0.1:1234/v1', presets)).toEqual([]);
    expect(matchOfficialProviders('https://unknown.example/team/v1', presets)).toEqual([]);
  });
  it.each(['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm'])('binds %s to the remote prefix, never localhost', id => {
    const preset = presets.find(p => p.id === id)!;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const bound = bindDetectedProvider(preset, agent, 'https://relay.example/team/v1');
      if (!preset.runtimes[agent]) { expect(bound).toBeUndefined(); continue; }
      expect(bound).toBeDefined();
      expect(bound!.runtimes[agent]!.baseUrl).toMatch(/^https:\/\/relay\.example\/team(?:\/v1)?$/);
      expect(Object.keys(bound!.runtimes)).toEqual([agent]);
      if (bound!.runtimes[agent]!.modelsUrl) expect(bound!.runtimes[agent]!.modelsUrl).toMatch(/^https:\/\/relay\.example\/team\//);
    }
  });
  it('keeps business prefixes and rejects unsafe probe derivation', () => {
    expect(providerDeploymentRoot('https://EXAMPLE.com:443/team/v1/')).toBe('https://example.com/team');
    expect(providerDeploymentRoot('http://[::1]:8080/team')).toBe('http://[::1]:8080/team');
    for (const url of ['file:///tmp/x', 'https://user:fake@example.com/v1', 'https://example.com/v1?token=fake', 'https://example.com/v1#x', 'https://example.com/v1/chat/completions']) expect(providerDeploymentRoot(url)).toBeUndefined();
  });
});
