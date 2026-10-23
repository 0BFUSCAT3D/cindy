import path from 'node:path';
import { BUNDLED_CATALOG, buildRegistry, buildUserProvider, resolveRoute, type AgentKind, type Catalog, type CustomProviderConfig, type Effort, type ProviderView, type ResolvedRoute, type CatalogModel, type ProviderRuntimeModelConfig } from '@cindy/model-providers';
import type { TerminalSecrets } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';

export const ENGINES = ['claude-code', 'codex', 'pi'] as const;
export type ModelSelection = { agentKind: AgentKind; providerId: string; model: string; effort?: Effort };
type ModelState = { version: 1; providers: CustomProviderConfig[]; defaultSelection?: ModelSelection };
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
  private readonly nativeModels = new Map<AgentKind, CatalogModel[]>();
  private readonly discovery = new Map<AgentKind, Promise<void>>();
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(private readonly profileDir: string, private readonly secrets: TerminalSecrets, private readonly nativeStatus: NativeStatus, private readonly catalog: Catalog = BUNDLED_CATALOG, private readonly discover?: (kind: AgentKind) => Promise<CatalogModel[]>) {
    this.file = path.join(profileDir, 'models.json');
  }
  async open(): Promise<void> {
    await privateDirectory(this.profileDir);
    const raw = await readPrivateFile(this.file);
    if (!raw) return;
    const parsed = object(JSON.parse(raw.toString()));
    if (parsed.version !== 1 || !Array.isArray(parsed.providers)) throw new Error('UNSUPPORTED_MODEL_CONFIGURATION');
    const providers = parsed.providers.map(value => this.parseProvider(value));
    if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('DUPLICATE_PROVIDER');
    this.state = { version: 1, providers, ...(parsed.defaultSelection ? { defaultSelection: parseSelection(parsed.defaultSelection) } : {}) };
  }
  private parseProvider(value: unknown): CustomProviderConfig {
    const input = object(value);
    if (typeof input.id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(input.id) || this.catalog.providers.some(p => p.id === input.id)) throw new Error('INVALID_PROVIDER_ID');
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('INVALID_PROVIDER_NAME');
    const auth = input.auth === undefined ? { method: 'apiKey' } : object(input.auth);
    if (auth.method !== 'apiKey' && auth.method !== 'none') throw new Error('CUSTOM_OAUTH_REQUIRES_NATIVE_LOGIN');
    const runtimes = object(input.runtimes);
    const clean: CustomProviderConfig = { id: input.id, name: input.name.trim(), auth: { method: auth.method }, runtimes: {} };
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
        for (const key of ['contextWindow', 'defaultEnabled', 'api', 'piApi', 'reasoning', 'reasoningEfforts', 'reasoningDefaultEffort', 'supportsImageInput', 'thinkingToggle']) {
          if (model[key] !== undefined) copy[key] = model[key];
        }
        return copy;
      });
      const protocol = runtime.wireProtocol ?? (kind === 'claude-code' ? 'anthropic-messages' : kind === 'codex' ? 'openai-responses' : 'openai-chat');
      if (!['anthropic-messages', 'openai-responses', 'openai-chat'].includes(String(protocol))) throw new Error('INVALID_WIRE_PROTOCOL');

      clean.runtimes[kind as AgentKind] = {
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
  private activeCatalog(): Catalog {
    return { ...this.catalog, providers: [...this.catalog.providers.map(provider => { const kind = provider.id === 'openai' ? 'codex' : provider.id === 'anthropic' ? 'claude-code' : null; return kind && this.nativeModels.has(kind) ? { ...provider, models: { ...provider.models, [kind]: this.nativeModels.get(kind)! } } : provider; }), ...this.state.providers.map(p => buildUserProvider(p))] };
  }
  async views(): Promise<ProviderView[]> {
    await this.pending;
    const connected: Record<string, boolean> = {};
    for (const provider of this.state.providers) {
      connected[provider.id] = provider.auth?.method === 'none' || (await Promise.all(ENGINES.map(kind => this.secrets.get(this.key(provider.id, kind))))).some(Boolean);
    }
    const statuses = await Promise.all(['claude-code', 'codex'].map(async kind => [kind, await this.nativeStatus(kind as AgentKind)] as const));
    connected.anthropic = statuses[0][1].authenticated;
    connected.openai = statuses[1][1].authenticated;
    if (this.discover) await Promise.all(statuses.filter(([, state]) => state.authenticated).map(async ([kind]) => {
      let pending = this.discovery.get(kind as AgentKind);
      if (!pending) {
        pending = this.discover!(kind as AgentKind).then(models => { this.nativeModels.set(kind as AgentKind, models); }).catch(() => { this.discovery.delete(kind as AgentKind); });
        this.discovery.set(kind as AgentKind, pending);
      }
      await pending;
    }));
    return buildRegistry(this.activeCatalog(), connected);
  }
  snapshot() { return structuredClone(this.state); }
  async select(input?: unknown): Promise<{ selection: ModelSelection; route: ResolvedRoute }> {
    await this.pending;
    const views = await this.views();
    let selection = input ? parseSelection(input) : this.state.defaultSelection;
    if (!selection) {
      for (const kind of ENGINES) {
        const provider = views.find(p => p.connected && !p.suspended && p.models[kind]?.some(m => !m.disabled && m.defaultEnabled !== false));
        const model = provider?.models[kind]?.find(m => !m.disabled && m.defaultEnabled !== false);
        if (provider && model) { selection = { agentKind: kind, providerId: provider.id, model: model.id }; break; }
      }
    }
    if (!selection) throw new Error('MODEL_CONFIGURATION_REQUIRED');
    const route = resolveRoute(views, selection.providerId, selection.model, selection.agentKind);
    if (!route || !route.provider.connected || route.provider.suspended || route.model.disabled) throw new Error('MODEL_ROUTE_UNAVAILABLE');
    // Built-in subscriptions use the original vendor CLI. Cross-harness OAuth
    // needs a separately authorized credential bridge, never a copied login.
    if (route.provider.source !== 'user' && !((selection.agentKind === 'claude-code' && selection.providerId === 'anthropic') || (selection.agentKind === 'codex' && selection.providerId === 'openai'))) throw new Error('MODEL_ROUTE_REQUIRES_SUPPORTED_CONNECTION');
    const custom = this.state.providers.find(p => p.id === selection.providerId);
    if (custom && custom.auth?.method !== 'none' && !await this.secrets.get(this.key(selection.providerId, selection.agentKind))) throw new Error('MODEL_CREDENTIAL_REQUIRED');
    return { selection: structuredClone(selection), route };
  }
  private change(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async persist(state: ModelState): Promise<void> { await atomicPrivateWrite(this.file, JSON.stringify(state)); this.state = state; }
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
      const previous = new Map<string, string | null>();
      try {
        for (const [kind, value] of [...Object.entries(keys), ...headers.map(([kind, value]) => [`${kind}:headers`, value])]) {
          const key = `terminal:provider:${config.id}:${kind}`;
          previous.set(key, await this.secrets.get(key));
          guard();
          if (value) await this.secrets.set(key, value as string); else await this.secrets.delete(key);
        }
        guard();
        await this.persist({ ...this.state, providers: [...this.state.providers.filter(p => p.id !== config.id), config] });
      } catch (error) {
        for (const [key, value] of previous) { if (value === null) await this.secrets.delete(key); else await this.secrets.set(key, value); }
        throw error;
      }
    });
  }
  deleteProvider(id: string, guard: () => void = () => {}): Promise<void> {
    return this.change(async () => {
      guard();
      if (!this.state.providers.some(p => p.id === id)) throw new Error('PROVIDER_NOT_FOUND');
      const state = { ...this.state, providers: this.state.providers.filter(p => p.id !== id) };
      if (state.defaultSelection?.providerId === id) delete state.defaultSelection;
      await this.persist(state);
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
  credential(providerId: string, agent: AgentKind) { return this.secrets.get(this.key(providerId, agent)); }
  private key(id: string, agent: AgentKind) { return `terminal:provider:${id}:${agent}`; }
  async flush() { await this.pending; }
}
