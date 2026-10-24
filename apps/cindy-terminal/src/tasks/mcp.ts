import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchedulerMcpServer } from '../../../../packages/lizi-mcps/src/cindy_schedulerMcpServer.js';
import type { SchedulerMcpDeps } from '../../../../packages/lizi-mcps/src/types.js';
import { createXdtHelperMcpServer, type XdtHelperMcpDeps } from '../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js';
import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';
import { startCodexHttpBridge, withMcpRouteIdentity } from '@cindy/mcps/host/codexHttpBridge';
import type { AgentKind, Logger, McpProvider, McpProviderContext, PiExtraSpawnConfig, PiExtraSpawnConfigContext, CodexMcpThreadContextArgs } from '@cindy/maker-core';

/** Each task owns the bridge and its credentials. Caller identity comes from
 * the harness registrations shared with Desktop, never from tool arguments. */
export async function createTaskTools(options: {
  sessionId: string; workingDir: string; agentKind: AgentKind; logger: Logger;
  scheduler?: SchedulerMcpDeps;
  extraFactories?: Record<string, () => McpServer>;
  extraProviders?: McpProvider[];
  helper: XdtHelperMcpDeps; isCurrent(): boolean;
}) {
  let closed = false;
  const assertCurrent = () => { if (closed || !options.isCurrent()) throw new Error('TASK_TOOLS_REVOKED'); };
  const assertContext = (ctx: { sessionId?: string }) => { assertCurrent(); if (ctx.sessionId !== options.sessionId) throw new Error('TASK_MCP_SCOPE_MISMATCH'); };
  const context = { sessionId: options.sessionId, workingDir: options.workingDir, agentKind: options.agentKind };
  const httpContext: McpProviderContext = { agentKind: options.agentKind, workingDir: '', getSessionContext: () => {
    assertCurrent(); const active = getLiziMcpSessionContext();
    if (!active || active.sessionId !== options.sessionId || !['claude-code','codex','pi'].includes(active.agentKind)) return undefined;
    return { ...active, agentKind: active.agentKind as AgentKind, getSessionContext: httpContext.getSessionContext };
  } };
  const factories: Record<string, (ctx: McpProviderContext) => McpServer> = {
    cindy_helper: ctx => createXdtHelperMcpServer({ ...options.helper, authorizeCall: async input => {
      assertCurrent();
      const result = await options.helper.authorizeCall?.(input);
      if (result && !result.ok) return result;
      return { ok: true, run: async operation => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
    } }, ctx),
  };
  if (options.scheduler) factories.cindy_scheduler = ctx => createSchedulerMcpServer({ ...options.scheduler!, authorizeCall: async () => {
    assertCurrent(); return { ok: true, run: async operation => { assertCurrent(); const value = await operation(); assertCurrent(); return value; } };
  } }, ctx);
  const add = (name: string, factory: (ctx: McpProviderContext) => McpServer) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name) || Object.hasOwn(factories,name)) throw new Error('INVALID_MCP_FACTORY_NAME');
    factories[name] = ctx => { assertCurrent(); return factory(ctx); };
  };
  for (const [name, factory] of Object.entries(options.extraFactories ?? {})) add(name, factory);
  for (const provider of options.extraProviders ?? []) add(provider.name, ctx => {
    const config = provider.toClaudeSdkConfig?.(ctx) as { type?: unknown; instance?: McpServer } | null | undefined;
    if (!config || config.type !== 'sdk' || !config.instance) throw new Error('MCP_PROVIDER_UNAVAILABLE');
    return config.instance;
  });
  const bridge = await startCodexHttpBridge({ logger: options.logger, serverFactories: Object.fromEntries(Object.entries(factories).map(([name, factory]) => [name, () => factory(httpContext)])) });
  const envKey = `CINDY_TERMINAL_MCP_${randomBytes(8).toString('hex').toUpperCase()}`;
  const inProcess = new Set<McpServer>();
  const providers: McpProvider[] = Object.keys(factories).map(name => ({
    name,
    capability: { title: name === 'cindy_helper' ? 'Cindy tasks' : name === 'cindy_scheduler' ? 'Cindy schedules' : name, description: name === 'cindy_helper' ? 'Read and manage tasks on this computer' : name === 'cindy_scheduler' ? 'Manage scheduled tasks on this computer' : 'Tools for this task', source: 'builtin', ...(name === 'cindy_helper' ? { discovery: { tool: 'list_tools' } } : {}) },
    toClaudeSdkConfig: ctx => { assertContext(ctx); const instance = factories[name](ctx); inProcess.add(instance); return { type: 'sdk', name, instance }; },
    toCodexMcpConfig: ctx => { assertCurrent(); return { type: 'http', url: withMcpRouteIdentity(bridge.url(name), { sessionInstanceId: ctx.sessionInstanceId }), bearerTokenEnvVar: envKey }; },
    getExtraEnv: () => ({ [envKey]: bridge.token }),
  }));
  return {
    providers,
    codexArgs: providers.flatMap(provider => ['-c', `mcp_servers.${provider.name}.url=${JSON.stringify(bridge.url(provider.name))}`, '-c', `mcp_servers.${provider.name}.bearer_token_env_var=${JSON.stringify(envKey)}`, '-c', `mcp_servers.${provider.name}.tool_timeout_sec=600`]),
    env: { [envKey]: bridge.token },
    registerCodexMcpThreadContext: (input: CodexMcpThreadContextArgs) => { assertContext(input); bridge.registerThreadContext(input.threadId, { ...input, agentKind: 'codex' }); },
    unregisterCodexMcpThreadContext: (threadId: string, instanceId?: string) => bridge.unregisterThreadContext(threadId, instanceId),
    withCodexMcpDiscoveryContext: <T>(input: Pick<CodexMcpThreadContextArgs, 'sessionId' | 'sessionInstanceId' | 'workingDir' | 'vendorOptions' | 'remoteHostId'>, run: () => Promise<T>): Promise<T> => {
      assertContext(input); return bridge.withDiscoveryContext({ ...input, agentKind: 'codex' }, run);
    },
    pi: (input: PiExtraSpawnConfigContext = context): PiExtraSpawnConfig => {
      assertContext(input);
      const sessionId = options.sessionId;
      const ctx: LiziMcpSessionContext = { ...input, remoteHostId: input.remoteHostId ?? undefined, agentKind: input.agentKind ?? options.agentKind };
      const token = randomBytes(32).toString('hex');
      bridge.registerSessionCtx(sessionId, ctx);
      const generation = bridge.registerSessionToken(sessionId, token);
      return { mcpBridge: { token, servers: providers.map(provider => ({ name: provider.name, url: withMcpRouteIdentity(bridge.url(provider.name), input) })) },
        disposeSessionCtx: () => { bridge.unregisterSessionCtx(sessionId, ctx); bridge.unregisterSessionToken(sessionId, token, generation); } };
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...inProcess].map(instance => instance.close().catch(() => undefined)));
      inProcess.clear(); await bridge.shutdown();
    },
  };
}
