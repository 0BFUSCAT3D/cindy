import { createChatgptProxy } from './subscription-proxy.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { privateDirectory } from '../platform.js';
import { ClaudeCodeAgent, CodexAgent, PiAgent, type AgentKind, type AuthAdapter, type AuthState, type BaseAgent, type Logger, type CodexExtraSpawnConfig, type PiNativeProvidersResult, type MakerMemoryManager } from '@cindy/maker-core';
import { BUNDLED_CATALOG, findModelRegistryRoute, resolvePiModelRoute, type ResolvedRoute } from '@cindy/model-providers';
import type { createTaskTools } from '../tasks/mcp.js';
import type { TerminalModelConfig, ModelSelection } from './config.js';

import { createProviderProxy } from './proxy.js';
import { resolveBundledPiGatewayModelProfile, pruneAnthropicCompatForGateway } from '@cindy/model-providers/model-plane/pi-gateway-model-catalog';
import type { TerminalCapabilities } from '../tasks/capabilities.js';

import { nativeLoginStatus } from '../engines/native.js';
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
  const state = await nativeLoginStatus(kind, binary);
  return { authenticated: state === 'authenticated', ...(state === 'authenticated' ? { authSource: 'oauth' as const } : { errorReason: 'native_subscription_login_required' }) };
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
  taskShellEnv?: () => Record<string,string>;
  guestHome?: string;
  authorizeRequest?: (model: string) => Promise<boolean>;
  tools?: Awaited<ReturnType<typeof createTaskTools>>;
  memory?: MakerMemoryManager;
  capabilities?: Awaited<ReturnType<TerminalCapabilities['runtime']>>;
  contactsEnabled?: boolean;
  getGhostRosterPrompt?: () => string;
  getContactsPromptState?: () => 'enabled' | 'disabled';
  turnChangeCapture?: ConstructorParameters<typeof ClaudeCodeAgent>[0]['turnChangeCapture'];
}

/** Construct the real maker-core adapters. A task owns a route snapshot so
 * changing another task's provider cannot redirect an in-flight request. */
export async function createTerminalAgent(input: RuntimeInput): Promise<BaseAgent> {
  const { selection, route, binaryPath, models, profileDir, taskId, logger } = input;
  const chatgpt = route.provider.id === 'openai' && Boolean(models.nativeAccounts);
  const custom = chatgpt || route.provider.source === 'user' || route.provider.id === 'xd' || Boolean(route.provider.auth.oauth);
  const key = custom && !input.remote ? await models.credential(selection.providerId, selection.agentKind) : null;
  const codexHome = custom && !input.remote && selection.agentKind === 'codex' ? (input.guestHome ? path.join(input.guestHome,'codex') : path.join(profileDir, 'engines', 'codex', taskId)) : undefined;
  const claudeHome = input.guestHome && selection.agentKind==='claude-code' ? path.join(input.guestHome,'claude') : undefined;
  for(const directory of [codexHome,claudeHome])if(directory)await privateDirectory(directory);
  const proxy = chatgpt && !input.remote ? await createChatgptProxy({ route, kind: selection.agentKind, taskId, accounts: models.nativeAccounts!, authorize: input.authorizeRequest }) : custom && !input.remote ? await createProviderProxy(route, selection.agentKind, key, await models.headers(selection.providerId, selection.agentKind), input.authorizeRequest, route.provider.id === 'xd' ? key => models.reportGatewayRejection(key) : undefined, route.provider.auth.oauth ? () => models.credential(selection.providerId, selection.agentKind) : undefined) : null;
  const runtimeKey = proxy?.token ?? key;
  const endpoint = proxy?.url ?? route.routing.upstream;
  const own = (agent: BaseAgent) => { if (proxy) { const dispose = agent.dispose.bind(agent); agent.dispose = async () => { try { await dispose(); } finally { await proxy.close(); } }; } return agent; };
  const keyless = route.provider.auth.method === 'none';
  const auth: AuthAdapter = {
    async getState() {
      return custom ? { authenticated: chatgpt ? models.nativeAccounts!.connected() : keyless || Boolean(key), authSource: key ? 'api-key' : undefined } : selection.agentKind === 'claude-code' && models.nativeClaude ? models.nativeClaude.state() : nativeAuthState(selection.agentKind, binaryPath);
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
    turnChangeCapture: input.turnChangeCapture,
    makerMemory: input.memory,
    getGhostRosterPrompt: input.getGhostRosterPrompt,
    getManagedSkills: input.capabilities?.getManagedSkills,
    getDisabledSkillPaths: input.capabilities?.getDisabledSkillPaths,
    prepareCodexSkills: input.capabilities?.prepareCodexSkills,
    getContactsPromptState: input.getContactsPromptState ?? (() => input.contactsEnabled ? 'enabled' : 'disabled'),
    mcpProviders: input.tools?.providers,
    runtimeConfig: { taskShellEnv: input.taskShellEnv, userDataPath: input.guestHome ?? profileDir, ...(input.memory ? { makerMemoryEnabled: input.memory.isEnabled() } : {}), ...(custom && selection.agentKind === 'claude-code' ? { endpoint } : {}) },
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
          name: route.provider.name, baseUrl: proxy?.url ?? native.baseUrl,
          api: chatgpt ? 'openai-codex-responses' : native.wireProtocol === 'openai-chat' ? 'openai-completions' : native.wireProtocol,
          ...(runtimeKey ? { apiKeyEnvVar: 'CINDY_TERMINAL_PROVIDER_KEY' } : {}),
          models: catalogModels.flatMap(model => {
            const resolved = resolvePiModelRoute(model, { baseUrl: route.routing.upstream!, wireProtocol: route.routing.wireProtocol });
            if (!resolved) return [];
            const api = chatgpt ? 'openai-codex-responses' as const : resolved.wireProtocol === 'openai-chat' ? 'openai-completions' as const : resolved.wireProtocol;
            const bundled = route.provider.id === 'xd' ? resolveBundledPiGatewayModelProfile(model.id) : undefined;
            const metadata = bundled?.api === api ? bundled : undefined;
            const compat = api === 'anthropic-messages' ? pruneAnthropicCompatForGateway(metadata?.compat) : metadata?.compat;
            return [{ id: model.id, name: model.name, ...(chatgpt ? { wireId: model.id.replace(/^chatgpt\//, '') } : {}),
              api,
              ...(metadata?.samplingParams ? { samplingParams: metadata.samplingParams } : {}),
              ...(metadata?.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap as import('@cindy/maker-core').PiNativeModelSpec['thinkingLevelMap'] } : {}),
              ...(route.provider.id === 'xd' && (api === 'openai-completions' || api === 'anthropic-messages') ? { compat: { ...compat, sendSessionAffinityHeaders: true } } : compat ? { compat } : {}),
              // Endpoint overrides stay behind the per-model host proxy. Never
              // send its loopback capability to a user-supplied upstream URL.
              baseUrl: proxy?.url ?? resolved.baseUrl,
              contextWindow: model.contextWindow, ...(model.maxOutput ? { maxTokens: model.maxOutput } : {}),
              ...(model.cost?.input !== undefined && model.cost.output !== undefined ? { cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead ?? 0, cacheWrite: model.cost.cacheWrite ?? 0 } } : {}), supportsFastMode: model.supportsFastMode,
              reasoning: Boolean(model.efforts?.length), input: ['text' as const, ...(model.supportsImageInput ? ['image' as const] : [])],
            }];
          }),
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
