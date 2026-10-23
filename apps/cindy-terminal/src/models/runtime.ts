import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { privateDirectory } from '../platform.js';
import { ClaudeCodeAgent, CodexAgent, PiAgent, type AgentKind, type AuthAdapter, type AuthState, type BaseAgent, type Logger, type CodexExtraSpawnConfig, type PiNativeProvidersResult } from '@cindy/maker-core';
import { BUNDLED_CATALOG, findModelRegistryRoute, resolvePiModelRoute, type ResolvedRoute } from '@cindy/model-providers';
import type { createTaskTools } from '../tasks/mcp.js';
import type { TerminalModelConfig, ModelSelection } from './config.js';

import { createProviderProxy } from './proxy.js';

const execute = promisify(execFile);
const names = { 'claude-code': 'claude', codex: 'codex', pi: 'pi' } as const;

/** Locate installed native CLIs without a shell and without changing global HOME. */
export async function findAgentBinary(kind: AgentKind, explicit?: string): Promise<string | null> {
  const paths = explicit ? [explicit] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(dir => {
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    return extensions.map(ext => path.join(dir, names[kind] + ext));
  });
  for (const file of paths) {
    try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path.resolve(file); }
    catch { /* A missing PATH entry is not an installed engine. */ }
  }
  return null;
}

/** Query login via vendor commands only. Native credentials never enter Node. */
export async function nativeAuthState(kind: AgentKind, binary: string | null): Promise<AuthState> {
  if (!binary) return { authenticated: false, errorReason: 'engine_not_installed' };
  if (kind === 'pi') return { authenticated: false, errorReason: 'configure_a_provider_for_pi' };
  try {
    const result = await execute(binary, kind === 'claude-code' ? ['auth', 'status', '--json'] : ['login', 'status'], { timeout: 12_000, maxBuffer: 256_000, windowsHide: true });
    if (kind === 'claude-code') {
      const state = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      const subscribed = state.loggedIn === true && (state.authMethod === 'claude.ai' || Boolean(state.subscriptionType));
      return { authenticated: subscribed, ...(subscribed ? { authSource: 'oauth' as const } : { errorReason: 'native_subscription_login_required' }) };
    }
    // `codex login status` communicates success through its exit code, not a token.
    const text = result.stdout + result.stderr;
    return { authenticated: /logged in/i.test(text) && !/api key/i.test(text), authSource: 'oauth' };
  } catch { return { authenticated: false, errorReason: 'native_login_required' }; }
}

export interface RuntimeInput {
  profileDir: string;
  taskId: string;
  selection: ModelSelection;
  route: ResolvedRoute;
  binaryPath: string;
  models: TerminalModelConfig;
  logger: Logger;
  remote?: boolean;
  guestHome?: string;
  authorizeRequest?: (model: string) => Promise<boolean>;
  tools?: Awaited<ReturnType<typeof createTaskTools>>;
}

/** Construct the real maker-core adapters. A task owns a route snapshot so
 * changing another task's provider cannot redirect an in-flight request. */
export async function createTerminalAgent(input: RuntimeInput): Promise<BaseAgent> {
  const { selection, route, binaryPath, models, profileDir, taskId, logger } = input;
  const custom = route.provider.source === 'user';
  const key = custom && !input.remote ? await models.credential(selection.providerId, selection.agentKind) : null;
  const codexHome = custom && !input.remote && selection.agentKind === 'codex' ? (input.guestHome ? path.join(input.guestHome,'codex') : path.join(profileDir, 'engines', 'codex', taskId)) : undefined;
  const claudeHome = input.guestHome && selection.agentKind==='claude-code' ? path.join(input.guestHome,'claude') : undefined;
  for(const directory of [codexHome,claudeHome])if(directory)await privateDirectory(directory);
  const proxy = custom && !input.remote ? await createProviderProxy(route, selection.agentKind, key, await models.headers(selection.providerId, selection.agentKind), input.authorizeRequest) : null;
  const runtimeKey = proxy?.token ?? key;
  const endpoint = proxy?.url ?? route.routing.upstream;
  const own = (agent: BaseAgent) => { if (proxy) { const dispose = agent.dispose.bind(agent); agent.dispose = async () => { try { await dispose(); } finally { await proxy.close(); } }; } return agent; };
  const keyless = route.provider.auth.method === 'none';
  const auth: AuthAdapter = {
    async getState() {
      return custom ? { authenticated: keyless || Boolean(key), authSource: key ? 'api-key' : undefined } : nativeAuthState(selection.agentKind, binaryPath);
    },
    async getAuthEnv() {
      if (!custom) return {};
      const env: Record<string, string> = {};
      if (selection.agentKind === 'claude-code') {env.ANTHROPIC_API_KEY = runtimeKey ?? 'terminal-keyless';if(claudeHome)env.CLAUDE_CONFIG_DIR=claudeHome;}
      if (selection.agentKind === 'codex') {
        env.CINDY_TERMINAL_PROVIDER_KEY = runtimeKey ?? 'terminal-keyless';
        if (codexHome) env.CODEX_HOME = codexHome;
      }
      if (selection.agentKind === 'pi' && runtimeKey) env.CINDY_TERMINAL_PROVIDER_KEY = runtimeKey;
      return env;
    },
    async triggerLogin() { throw new Error('USE_NATIVE_CLI_LOGIN'); },
    async logout() { throw new Error('USE_NATIVE_CLI_LOGOUT'); },
  };
  const catalogModels = route.provider.models[selection.agentKind] ?? [];
  const deps = {
    auth, binaryPath, logger,
    mcpProviders: input.tools?.providers,
    runtimeConfig: { userDataPath: input.guestHome ?? profileDir, ...(custom && selection.agentKind === 'claude-code' ? { endpoint } : {}) },
    capabilityAdditions: { availableModels: catalogModels.map(model => ({
      id: model.id, displayName: model.name, contextWindow: model.contextWindow,
      efforts: model.efforts ?? [], defaultEffort: model.defaultEffort ?? null,
    })) },
    resolveModelContextLimit: (_provider: string | null | undefined, id: string) => catalogModels.find(model => model.id === id)?.contextWindow ?? null,
  };
  if (selection.agentKind === 'claude-code') return own(new ClaudeCodeAgent(deps));
  if (selection.agentKind === 'codex') return own(new CodexAgent({
    ...deps,
    prepareCodexExtraSpawnConfig: async (): Promise<CodexExtraSpawnConfig> => {
      if (!custom) return { extraArgs: input.tools?.codexArgs ?? [], extraEnv: input.tools?.env ?? {} };
      const provider = 'cindy_terminal';
      return {
        extraArgs: [
          ...(input.tools?.codexArgs ?? []),
          '-c', `model_provider=${JSON.stringify(provider)}`,
          '-c', `model_providers.${provider}.name=${JSON.stringify(route.provider.name)}`,
          '-c', `model_providers.${provider}.base_url=${JSON.stringify(endpoint)}`,
          '-c', `model_providers.${provider}.wire_api="responses"`,
          '-c', `model_providers.${provider}.env_key="CINDY_TERMINAL_PROVIDER_KEY"`,
          '-c', `model_providers.${provider}.supports_websockets=false`,
        ],
        extraEnv: { ...input.tools?.env, CINDY_TERMINAL_PROVIDER_KEY: runtimeKey ?? 'terminal-keyless' },
        codexCustomProviderRoutes: [{ providerId: selection.providerId, modelProviderId: provider, capabilities: {}, responseModels: catalogModels.map(model => model.id) }],
      };
    },
  }));
  return own(new PiAgent({
    ...deps,
    preparePiExtraSpawnConfig: async () => input.tools?.pi() ?? null,
    resolvePiAgentHome: () => input.guestHome ? path.join(input.guestHome,'pi') : path.join(profileDir, 'engines', 'pi', taskId),
    resolvePiNativeProviders: async (): Promise<PiNativeProvidersResult> => {
      const native = resolvePiModelRoute(route.model, { baseUrl: endpoint, wireProtocol: route.routing.wireProtocol });
      if (!native) throw new Error('PI_MODEL_PROTOCOL_UNSUPPORTED');
      return {
        providers: [{
          id: selection.providerId, sourceProviderId: selection.providerId,
          name: route.provider.name, baseUrl: native.baseUrl,
          api: native.wireProtocol === 'openai-chat' ? 'openai-completions' : native.wireProtocol,
          ...(runtimeKey ? { apiKeyEnvVar: 'CINDY_TERMINAL_PROVIDER_KEY' } : {}),
          models: catalogModels.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, reasoning: Boolean(model.efforts?.length), input: ['text' as const, ...(model.supportsImageInput ? ['image' as const] : [])] })),
        }],
        env: runtimeKey ? { CINDY_TERMINAL_PROVIDER_KEY: runtimeKey } : {},
      };
    },
  }));
}

/** Native account discovery asks the actual adapter; no cached credential files are read. */
export async function discoverNativeModels(kind: AgentKind, binaryPath: string, profileDir: string, logger: Logger) {
  if (kind === 'pi') return [];
  const auth: AuthAdapter = {
    getState: () => nativeAuthState(kind, binaryPath), getAuthEnv: async () => ({}),
    triggerLogin: async () => { throw new Error('USE_NATIVE_CLI_LOGIN'); }, logout: async () => { throw new Error('USE_NATIVE_CLI_LOGOUT'); },
  };
  const result: import('@cindy/model-providers').CatalogModel[] = [];
  const deps = { auth, binaryPath, logger, runtimeConfig: { userDataPath: profileDir } };
  const agent = kind === 'codex' ? new CodexAgent({ ...deps, onCodexLocalModelsListed: models => {
    for (const [index, model] of models.entries()) {
      if (model.hidden || !model.model) continue;
      const efforts = (model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? []).filter((effort): effort is import('@cindy/model-providers').Effort => ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort));
      result.push({ id: model.model, name: model.displayName || model.model, description: model.description,
        sortOrder: index, defaultEnabled: true, contextWindow: findModelRegistryRoute(BUNDLED_CATALOG.modelRegistry, 'openai', model.model, 'codex')?.entry.contextWindow ?? 272_000, efforts, defaultEffort: efforts.includes(model.defaultReasoningEffort as import('@cindy/model-providers').Effort) ? model.defaultReasoningEffort as import('@cindy/model-providers').Effort : null });
    }
  } }) : new ClaudeCodeAgent(deps);
  try {
    await agent.refreshLocalModels({ credentialMode: 'oauth-bearer', ...(kind === 'claude-code' ? { onSupportedModels: (models: unknown[]) => {
      for (const raw of models) {
        if (!raw || typeof raw !== 'object') continue;
        const model = raw as { value?: string; displayName?: string; description?: string };
        if (model.value) result.push({ id: model.value, name: model.displayName ?? model.value, description: model.description, defaultEnabled: true, contextWindow: findModelRegistryRoute(BUNDLED_CATALOG.modelRegistry, 'anthropic', model.value, 'claude-code')?.entry.contextWindow ?? 200_000, efforts: [], defaultEffort: null });
      }
    } } : {}) });
    return result;
  } finally { await agent.dispose(); }
}
