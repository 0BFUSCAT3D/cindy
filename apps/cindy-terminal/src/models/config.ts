import path from 'node:path';
import { BUNDLED_CATALOG, buildRegistry, buildUserProvider, resolveRoute, type AgentKind, type Catalog, type CustomProviderConfig, type Effort, type ProviderView, type ResolvedRoute, type CatalogModel, type ProviderRuntimeModelConfig, type ModelDisableOverrides, modelDisableKey, MODEL_METADATA_FIELDS, validModelMetadata, isProviderRequestPath, PI_MODEL_APIS } from '@cindy/model-providers';
import type { TerminalSecrets } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import { createActiveCatalog } from '@cindy/model-providers/model-plane/activeCatalog';
import type { TerminalClaudeLogin } from './claude-login.js';
import type { TerminalNativeAccounts } from './native-accounts.js';
import { validateAuthSection } from '@cindy/model-providers/provider-auth/configuration';

export interface ModelOAuthConnection {
  connected(id: string): boolean;
  credential(id: string): Promise<string | null>;
  disconnect(id: string): void;
  removeReversibly(id: string): () => void;
  refresh(id: string): Promise<void>;
}

export const ENGINES = ['claude-code', 'codex', 'pi'] as const;
export type ModelSelection = { agentKind: AgentKind; providerId: string; model: string; effort?: Effort };
type ModelState = { version: 1; providers: CustomProviderConfig[]; defaultSelection?: ModelSelection; disabled?: ModelDisableOverrides };
export type NativeStatus = (agent: AgentKind) => Promise<{ authenticated: boolean }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MODEL_CONFIGURATION');
  return value as Record<string, unknown>;
}
export function parseSelection(value: unknown): ModelSelection {
  const item = object(value);
  if (!ENGINES.includes(item.agentKind as AgentKind) || typeof item.providerId !== 'string' || !item.providerId || typeof item.model !== 'string' || !item.model) throw new Error('INVALID_MODEL_SELECTION');
  if (item.effort !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(String(item.effort))) throw new Error('INVALID_MODEL_EFFORT');
  return { agentKind: item.agentKind as AgentKind, providerId: item.providerId, model: item.model, ...(item.effort !== undefined ? { effort: item.effort as Effort } : {}) };
}

/** Non-secret user overrides; provider metadata continues to come from the shared catalog. */
export class TerminalModelConfig {
  private state: ModelState = { version: 1, providers: [] };
  readonly catalogRuntime: ReturnType<typeof createActiveCatalog>;
  private readonly discovery = new Map<AgentKind, Promise<void>>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private gateway: (() => { apiKey: string; endpoint: string } | null) | undefined;
  private refreshGateway?: () => Promise<void>;
  private rejectGateway?: (key: string | null | undefined) => void;
  private mutations = 0;
  private oauth?: ModelOAuthConnection;
  nativeAccounts?: TerminalNativeAccounts;
  nativeClaude?: TerminalClaudeLogin;
  private nativeModels?: CatalogModel[];
  connectNative(connection: TerminalNativeAccounts) { this.nativeAccounts = connection; this.generation++; }

  connectOAuth(connection: ModelOAuthConnection) { this.oauth = connection; this.generation++; }
  constructor(private readonly profileDir: string, private readonly secrets: TerminalSecrets, private readonly nativeStatus: NativeStatus, private readonly catalog: Catalog = BUNDLED_CATALOG, private readonly discover?: (kind: AgentKind) => Promise<CatalogModel[]>, region: 'cn' | 'global' = 'global') {
    this.file = path.join(profileDir, 'models.json');
    this.catalogRuntime = createActiveCatalog(region);
    this.catalogRuntime.setActiveCatalog(catalog, { capabilityEvidence: catalog === BUNDLED_CATALOG ? 'fallback' : 'current' });
  }
  async open(): Promise<void> {
    await privateDirectory(this.profileDir);
    const raw = await readPrivateFile(this.file);
    if (!raw) return;
    const parsed = object(JSON.parse(raw.toString()));
    if (parsed.version !== 1 || !Array.isArray(parsed.providers)) throw new Error('UNSUPPORTED_MODEL_CONFIGURATION');
    const providers = parsed.providers.map(value => this.parseProvider(value));
    if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('DUPLICATE_PROVIDER');
    this.state = { version: 1, providers, ...(parsed.disabled && typeof parsed.disabled==='object' ? {disabled: parsed.disabled as ModelDisableOverrides} : {}), ...(parsed.defaultSelection ? { defaultSelection: parseSelection(parsed.defaultSelection) } : {}) };
    this.catalogRuntime.setCustomProviderConfigs(providers);
  }
  private parseProvider(value: unknown): CustomProviderConfig {
    const input = object(value);
    if (typeof input.id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(input.id) || this.catalogRuntime.getActiveCatalog().providers.some(p => p.id === input.id && p.source !== 'user')) throw new Error('INVALID_PROVIDER_ID');
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('INVALID_PROVIDER_NAME');
    const auth = input.auth === undefined ? { method: 'apiKey' } : object(input.auth);
    if (!validateAuthSection(auth).ok || auth.native !== undefined) throw new Error('INVALID_PROVIDER_AUTH');
    const runtimes = object(input.runtimes);
    const clean: CustomProviderConfig = { id: input.id, name: input.name.trim(), auth: (auth.method === 'oauth' ? { method: 'oauth', oauth: structuredClone(auth.oauth) } : { method: auth.method }) as CustomProviderConfig['auth'], runtimes: {} };
    for (const [kind, raw] of Object.entries(runtimes)) {
      if (!ENGINES.includes(kind as AgentKind)) throw new Error('INVALID_ENGINE');
      const runtime = object(raw);
      if (runtime.headers) this.validateHeaders(runtime.headers);
      if (typeof runtime.baseUrl !== 'string') throw new Error('INVALID_PROVIDER_URL');
      const url = new URL(runtime.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_PROVIDER_URL');
      if (!Array.isArray(runtime.models) || runtime.models.length === 0) throw new Error('PROVIDER_MODELS_REQUIRED');
      // Only explicitly supported metadata crosses the persistence boundary; keys and
      // custom headers are held by TerminalSecrets, never smuggled into this JSON.
      const models = runtime.models.map(value => {
        const model = object(value);
        if (typeof model.id !== 'string' || !model.id.trim()) throw new Error('INVALID_MODEL_ID');
        const copy: Record<string, unknown> = { id: model.id, name: typeof model.name === 'string' ? model.name : model.id };
        if (model.contextWindow !== undefined && (typeof model.contextWindow !== 'number' || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1)) throw new Error('INVALID_CONTEXT_WINDOW');
        for (const key of [...MODEL_METADATA_FIELDS, 'defaultEnabled', 'api', 'piApi', 'reasoning', 'reasoningEfforts', 'reasoningDefaultEffort', 'thinkingToggle', 'discoveredMetadata', 'discoveredCost', 'nameExplicit', 'supportsUltrafastMode', 'route']) {
          if (model[key] !== undefined) copy[key] = model[key];
        }
        for(const key of MODEL_METADATA_FIELDS)if(copy[key]!==undefined&&!validModelMetadata({[key]:copy[key]}))throw new Error('INVALID_MODEL_METADATA');
        for(const key of ['api','piApi'])if(copy[key]!==undefined&&!PI_MODEL_APIS.includes(copy[key] as typeof PI_MODEL_APIS[number]))throw new Error('INVALID_MODEL_API');
        if(copy.route){const route=object(copy.route);const routeUrl=new URL(String(route.baseUrl));if(routeUrl.origin!==url.origin||routeUrl.username||routeUrl.password||routeUrl.search||routeUrl.hash||!['anthropic-messages','openai-responses','openai-chat','google-generative-ai'].includes(String(route.wireProtocol))||route.requestPath!==undefined&&!isProviderRequestPath(route.requestPath))throw new Error('INVALID_MODEL_ROUTE');copy.route={baseUrl:route.baseUrl,wireProtocol:route.wireProtocol,...(route.requestPath?{requestPath:route.requestPath}:{})};}
        if(copy.discoveredMetadata!==undefined&&!validModelMetadata(copy.discoveredMetadata))throw new Error('INVALID_MODEL_METADATA');
        if(copy.discoveredCost!==undefined){const cost=object(copy.discoveredCost);copy.discoveredCost=Object.fromEntries(Object.entries(cost).filter(([key])=>['input','output','cacheRead','cacheWrite'].includes(key)).map(([key,value])=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('INVALID_MODEL_COST');return [key,value];}));}
        return copy;
      });
      const protocol = runtime.wireProtocol ?? (kind === 'claude-code' ? 'anthropic-messages' : kind === 'codex' ? 'openai-responses' : 'openai-chat');
      if (!['anthropic-messages', 'openai-responses', 'openai-chat', 'google-generative-ai'].includes(String(protocol))) throw new Error('INVALID_WIRE_PROTOCOL');

      if(runtime.requestPath!==undefined&&!isProviderRequestPath(runtime.requestPath))throw new Error('INVALID_PROVIDER_PATH');
      if(runtime.modelsUrl!==undefined){const target=new URL(String(runtime.modelsUrl));if(!['https:','http:'].includes(target.protocol)||target.username||target.password||target.hash)throw new Error('INVALID_MODELS_URL');}
      const fields:Record<string,unknown>={};
      for(const key of ['catalogPresetId','piCatalogProviderId','modelsUrl','requestPath'])if(runtime[key]!==undefined){if(typeof runtime[key]!=='string'||(runtime[key] as string).length>2048)throw new Error('INVALID_PROVIDER_CONFIGURATION');fields[key]=runtime[key];}
      if(runtime.supportsImageGeneration!==undefined){if(typeof runtime.supportsImageGeneration!=='boolean')throw new Error('INVALID_PROVIDER_CONFIGURATION');fields.supportsImageGeneration=runtime.supportsImageGeneration;}
      if(runtime.imageApi!==undefined){if(runtime.imageApi!=='openai-images')throw new Error('INVALID_PROVIDER_CONFIGURATION');fields.imageApi=runtime.imageApi;}
      if(runtime.videoApi!==undefined){if(runtime.videoApi!=='xai-videos')throw new Error('INVALID_PROVIDER_CONFIGURATION');fields.videoApi=runtime.videoApi;}
      clean.runtimes[kind as AgentKind] = {
        ...fields,
        baseUrl: runtime.baseUrl.replace(/\/+$/, ''),
        wireProtocol: protocol as 'anthropic-messages' | 'openai-responses' | 'openai-chat',
        models: models as unknown as ProviderRuntimeModelConfig[],
      };
    }
    if (!Object.keys(clean.runtimes).length) throw new Error('PROVIDER_RUNTIME_REQUIRED');
    // Exercise the same expansion/validation as Desktop before committing anything.
    buildUserProvider(clean);
    return clean;
  }
  previewProvider(input:unknown) {
    const provider=this.parseProvider(input);const kind=Object.keys(provider.runtimes)[0] as AgentKind;
    const view=buildRegistry({...this.activeCatalog(),providers:[buildUserProvider(provider)]},{[provider.id]:true});
    const model=provider.runtimes[kind]!.models[0].id;const route=resolveRoute(view,provider.id,model,kind);
    if(!route)throw new Error('MODEL_ROUTE_UNAVAILABLE');return {route,selection:{agentKind:kind,providerId:provider.id,model}};
  }
  presets() { return structuredClone(this.activeCatalog().presets ?? []); }
  async refresh(providerId:string) {
    if (this.oauth && this.activeCatalog().providers.find(p => p.id === providerId)?.auth.oauth) { await this.oauth.refresh(providerId); return { ok: true as const, providerId }; }
    if (providerId === 'openai' && this.nativeAccounts) { await this.nativeAccounts.models(true); this.generation++; return { ok: true as const, providerId }; }
    if (providerId === 'xd' && this.refreshGateway) { await this.refreshGateway(); return { ok: true as const, providerId }; }
    const kind=providerId==='openai'?'codex':providerId==='anthropic'?'claude-code':null;
    if(!kind||!this.discover)throw new Error('PROVIDER_DISCOVERY_UNAVAILABLE');
    this.discovery.delete(kind);await this.views();
    if(!this.discovery.has(kind))throw new Error('PROVIDER_DISCOVERY_FAILED');
    return {ok:true as const,providerId};
  }
  setDisabled(input:unknown,guard:()=>void) {
    const patch=object(input);const id=patch.providerId;
    if(typeof id!=='string'||!id||id.length>256||!['model','provider','reset'].includes(String(patch.kind)))throw new Error('INVALID_MODEL_DISABLE');
    if(patch.kind!=='reset'&&typeof patch.disabled!=='boolean')throw new Error('INVALID_MODEL_DISABLE');
    const ids=patch.modelIds;
    if(patch.kind==='model'&&(!Array.isArray(ids)||ids.length<1||ids.length>512||ids.some(id=>typeof id!=='string'||!id||id.length>256)))throw new Error('INVALID_MODEL_DISABLE');
    return this.change(async()=>{
      guard();const provider=buildRegistry(this.activeCatalog(),{}).find(p=>p.id===id);
      if(patch.disabled&&!provider)throw new Error('PROVIDER_NOT_FOUND');
      if(patch.kind==='model'&&patch.disabled&&(ids as string[]).some(id=>!Object.values(provider!.models).some(models=>models?.some(m=>m.id===id))))throw new Error('MODEL_NOT_FOUND');
      const disabled=structuredClone(this.state.disabled??{});disabled.disabledProviders??={};disabled.disabledModels??={};
      if(patch.kind==='reset'){delete disabled.disabledProviders[id];for(const key of Object.keys(disabled.disabledModels))if(key.startsWith(id+':'))delete disabled.disabledModels[key];}
      else if(patch.kind==='provider'){if(patch.disabled)disabled.disabledProviders[id]=true;else delete disabled.disabledProviders[id];}
      else for(const modelId of ids as string[]){const key=modelDisableKey(id,modelId);if(patch.disabled)disabled.disabledModels[key]=true;else delete disabled.disabledModels[key];}
      guard();await this.persist({...this.state,disabled});
    });
  }
  disconnect(id:string,guard:()=>void) {return this.change(async()=>{guard();if(id==='openai'&&this.nativeAccounts){this.nativeAccounts.disconnect();return;}if(!this.state.providers.some(p=>p.id===id))throw new Error('PROVIDER_NOT_FOUND');if(this.activeCatalog().providers.find(p=>p.id===id)?.auth.oauth){if(!this.oauth)throw new Error('PROVIDER_CONNECTION_UNAVAILABLE');this.oauth.disconnect(id);}for(const kind of ENGINES){guard();await this.secrets.delete(this.key(id,kind));}});}
  connectGateway(read: () => { apiKey: string; endpoint: string } | null, refresh?: () => Promise<void>, rejected?: (key: string | null | undefined) => void) { this.gateway = read; this.refreshGateway = refresh; this.rejectGateway = rejected; }
  gatewayCredentials() { return this.gateway?.() ?? null; }
  reportGatewayRejection(key: string | null | undefined) { this.rejectGateway?.(key); }
  isMutating() { return this.mutations > 0; }
  gatewayChanged() { this.generation += 1; }
  activeCatalog(): Catalog {
    const catalog = this.catalogRuntime.getActiveCatalog(), gateway = this.gateway?.();
    if (!gateway) return catalog;
    return { ...catalog, providers: catalog.providers.map(provider => provider.id !== 'xd' ? provider : {
      ...provider, routing: Object.fromEntries(Object.entries(provider.routing).map(([kind, route]) => [kind, { ...route, upstream: gateway.endpoint, authStrategy: 'api-key-header' }])),
    }) };
  }
  async views(): Promise<ProviderView[]> {
    await this.pending;
    const connected: Record<string, boolean> = {};
    for (const provider of this.state.providers) {
      connected[provider.id] = provider.auth?.method === 'oauth' ? Boolean(this.oauth?.connected(provider.id)) : provider.auth?.method === 'none' || (await Promise.all(ENGINES.map(kind => this.secrets.get(this.key(provider.id, kind))))).some(Boolean);
    }
    for (const provider of this.activeCatalog().providers) if (provider.auth.oauth) connected[provider.id] = Boolean(this.oauth?.connected(provider.id));
    const statuses = await Promise.all(['claude-code', 'codex'].map(async kind => [kind, kind === 'codex' && this.nativeAccounts ? { authenticated: this.nativeAccounts.connected() } : kind === 'claude-code' && this.nativeClaude ? await this.nativeClaude.state() : await this.nativeStatus(kind as AgentKind)] as const));
    connected.anthropic = statuses[0][1].authenticated;
    connected.openai = statuses[1][1].authenticated;
    connected.xd = Boolean(this.gateway?.());
    if (connected.openai && this.nativeAccounts) {
      const models = await this.nativeAccounts.models().catch(() => this.nativeModels);
      if (models && models !== this.nativeModels) { this.catalogRuntime.setDiscoveredCodexModels(models); this.nativeModels = models; }
    }
    if (this.discover) await Promise.all(statuses.filter(([kind, state]) => state.authenticated && !(kind === 'codex' && this.nativeAccounts)).map(async ([kind]) => {
      let pending = this.discovery.get(kind as AgentKind);
      if (!pending) {
        pending = this.discover!(kind as AgentKind).then(models => {
          if (kind === 'codex') this.catalogRuntime.setDiscoveredCodexModels(models, { source: 'list' });
          else this.catalogRuntime.setAnthropicDiscoveredModels(models);
        }).catch(() => { this.discovery.delete(kind as AgentKind); });
        this.discovery.set(kind as AgentKind, pending);
      }
      await pending;
    }));
    return buildRegistry(this.activeCatalog(), connected, {}, this.state.disabled);
  }
  snapshot() { return structuredClone(this.state); }
  providerSources() { return this.activeCatalog().providers.map(({ id, source }) => ({ id, source })); }
  private generation = 0;
  revision() { return this.generation + this.catalogRuntime.getActiveCatalogRevision(); }
  async select(input?: unknown): Promise<{ selection: ModelSelection; route: ResolvedRoute; modelRevision: number }> {
    await this.pending;
    const views = await this.views();
    const modelRevision = this.revision();
    let selection = input ? parseSelection(input) : this.state.defaultSelection;
    if (!selection) {
      for (const kind of ENGINES) {
        const provider = views.find(p => p.connected && !p.suspended && (p.source === 'user' || p.id === 'xd' || kind === 'claude-code' && p.id === 'anthropic' || kind === 'codex' && p.id === 'openai') && p.models[kind]?.some(m => !m.disabled && m.defaultEnabled !== false));
        const model = provider?.models[kind]?.find(m => !m.disabled && m.defaultEnabled !== false);
        if (provider && model) { selection = { agentKind: kind, providerId: provider.id, model: model.id }; break; }
      }
    }
    if (!selection) throw new Error('MODEL_CONFIGURATION_REQUIRED');
    const route = resolveRoute(views, selection.providerId, selection.model, selection.agentKind);
    if (!route || !route.provider.connected || route.provider.suspended || route.model.disabled) throw new Error('MODEL_ROUTE_UNAVAILABLE');
    // Built-in subscriptions use the original vendor CLI. Cross-harness OAuth
    // needs a separately authorized credential bridge, never a copied login.
    if (selection.providerId === 'xd' && this.catalogRuntime.isXdGatewayPaymentRequiredRoute(selection.model, selection.agentKind)) throw new Error('MODEL_PAYMENT_REQUIRED');
    if (route.provider.source !== 'user' && !(selection.providerId === 'xd' && this.gateway?.()) && !(route.provider.auth.oauth && this.oauth?.connected(selection.providerId)) && !(selection.providerId === 'openai' && this.nativeAccounts?.connected()) && !((selection.agentKind === 'claude-code' && selection.providerId === 'anthropic') || (selection.agentKind === 'codex' && selection.providerId === 'openai'))) throw new Error('MODEL_ROUTE_REQUIRES_SUPPORTED_CONNECTION');
    const custom = this.state.providers.find(p => p.id === selection.providerId);
    if (custom && custom.auth?.method !== 'none' && !await this.credential(selection.providerId, selection.agentKind)) throw new Error('MODEL_CREDENTIAL_REQUIRED');
    if (modelRevision !== this.revision() || this.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    return { selection: structuredClone(selection), route, modelRevision };
  }
  private change(operation: () => Promise<void>): Promise<void> {
    this.mutations += 1;
    const result = this.pending.then(async () => { try { await operation(); } finally { this.generation += 1; this.mutations -= 1; } });
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async persist(state: ModelState): Promise<void> { await atomicPrivateWrite(this.file, JSON.stringify(state)); this.state = state; this.catalogRuntime.setCustomProviderConfigs(state.providers); }
  setDefault(input: unknown, guard: () => void = () => {}): Promise<void> {
    const selection = parseSelection(input);
    return this.change(async () => {
      guard();
      const route = resolveRoute(buildRegistry(this.activeCatalog(), {}), selection.providerId, selection.model, selection.agentKind);
      if (!route) throw new Error('MODEL_ROUTE_UNAVAILABLE');
      await this.persist({ ...this.state, defaultSelection: selection });
    });
  }
  resetDefault(guard: () => void = () => {}): Promise<void> { return this.change(async () => { guard(); const { defaultSelection: _, ...state } = this.state; await this.persist(state); }); }
  saveProvider(input: unknown, runtimeKeys: unknown = {}, createOnly = false, guard: () => void = () => {}): Promise<void> {
    const config = this.parseProvider(input);
    const keys = object(runtimeKeys);
    const headers = Object.entries(object(object(input).runtimes)).filter(([, runtime]) => Object.prototype.hasOwnProperty.call(object(runtime), 'headers')).map(([kind, runtime]) => [kind, JSON.stringify(this.validateHeaders(object(runtime).headers))] as const);
    if (Object.entries(keys).some(([kind, value]) => !ENGINES.includes(kind as AgentKind) || typeof value !== 'string')) throw new Error('INVALID_PROVIDER_KEYS');
    return this.change(async () => {
      guard();
      const exists = this.state.providers.some(p => p.id === config.id);
      if (createOnly && exists) throw new Error('PROVIDER_ALREADY_EXISTS');
      if (!createOnly && !exists) throw new Error('PROVIDER_NOT_FOUND');
      const oldAuth = this.state.providers.find(p => p.id === config.id)?.auth;
      const previous = new Map<string, string | null>();
      let restoreOAuth: (() => void) | undefined;
      try {
        if (oldAuth?.method === 'oauth' && JSON.stringify(oldAuth) !== JSON.stringify(config.auth)) restoreOAuth = this.oauth?.removeReversibly(config.id);
        for (const [kind, value] of [...Object.entries(keys), ...headers.map(([kind, value]) => [`${kind}:headers`, value])]) {
          const key = `terminal:provider:${config.id}:${kind}`;
          previous.set(key, await this.secrets.get(key));
          guard();
          if (value) await this.secrets.set(key, value as string); else await this.secrets.delete(key);
        }
        guard();
        await this.persist({ ...this.state, providers: [...this.state.providers.filter(p => p.id !== config.id), config] });
      } catch (error) {
        restoreOAuth?.();
        for (const [key, value] of previous) { if (value === null) await this.secrets.delete(key); else await this.secrets.set(key, value); }
        throw error;
      }
    });
  }
  deleteProvider(id: string, guard: () => void = () => {}): Promise<void> {
    return this.change(async () => {
      guard();
      if (!this.state.providers.some(p => p.id === id)) throw new Error('PROVIDER_NOT_FOUND');
      const oauth = this.state.providers.find(p => p.id === id)?.auth?.method === 'oauth';
      const state = { ...this.state, providers: this.state.providers.filter(p => p.id !== id) };
      if (state.defaultSelection?.providerId === id) delete state.defaultSelection;
      const restoreOAuth = oauth ? this.oauth?.removeReversibly(id) : undefined;
      try { await this.persist(state); } catch (error) { restoreOAuth?.(); throw error; }
      for (const kind of ENGINES) { await this.secrets.delete(this.key(id, kind)); await this.secrets.delete(`${this.key(id, kind)}:headers`); }
    });
  }
  private validateHeaders(value: unknown): Record<string, string> {
    const headers = object(value);
    const clean: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) throw new Error('INVALID_PROVIDER_HEADER');
      clean[name.toLowerCase()] = value;
    }
    return clean;
  }
  async headers(providerId: string, agent: AgentKind): Promise<Record<string, string>> {
    const value = await this.secrets.get(`${this.key(providerId, agent)}:headers`);
    return value ? this.validateHeaders(JSON.parse(value)) : {};
  }
  credential(providerId: string, agent: AgentKind): Promise<string | null> {
    if (this.activeCatalog().providers.find(p=>p.id===providerId)?.auth.oauth) return this.oauth?.credential(providerId) ?? Promise.resolve(null);
    return providerId === 'xd' ? Promise.resolve(this.gateway?.()?.apiKey ?? null) : this.secrets.get(this.key(providerId, agent));
  }
  private key(id: string, agent: AgentKind) { return `terminal:provider:${id}:${agent}`; }
  /** Private request snapshot. Credentials and headers never enter model views. */
  async utilityCredentials() {
    await this.views();
    const revision = this.revision();
    const keys = new Map<string, string | null>();
    const catalog = structuredClone(this.activeCatalog());
    for (const provider of catalog.providers) {
      if (provider.source !== 'user') continue;
      for (const kind of provider.agents) {
        keys.set(`${provider.id}:${kind}`, await this.credential(provider.id, kind));
        const routing = provider.routing[kind];
        if (routing) routing.headerOverride = { ...routing.headerOverride, ...await this.headers(provider.id, kind) };
      }
    }
    if (revision !== this.revision() || this.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    return { revision, catalog, readKey: (id: string, kind: string) => revision === this.revision() && !this.isMutating() ? keys.get(`${id}:${kind}`) ?? null : null };
  }
  async flush() { await this.pending; }
}
