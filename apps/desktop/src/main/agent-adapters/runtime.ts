import {
  resolveUnifiedRoute,
  type UnifiedRoute,
  type UnifiedRouteCatalog,
  type UnifiedRouteRequest,
} from '@cindy/maker-core/agent-adapters';
import type {
  AgentAdapter,
  AgentAdapterMetadata,
  AgentInstanceRef,
  AgentSession,
  AgentStartRequest,
  ExistingProviderRouteRef,
  OfficialApiAccountRef,
  RuntimeNodeRef,
} from '@cindy/maker-core/agent-adapters';

import {
  AgentAdapterRegistry,
  type AgentAdapterDiscoveryResult,
  type AgentAdapterStatusProjection,
} from './registry.js';
import { RuntimeNodeDirectory } from './runtime-node-directory.js';
import { projectRuntimeNodes, type RuntimeNodeSourceSnapshot } from './runtime-node-sources.js';

function copyExistingProviderRoute(route: ExistingProviderRouteRef): ExistingProviderRouteRef {
  return {
    id: route.id,
    providerId: route.providerId,
    ...(route.runtimeNodeId !== undefined ? { runtimeNodeId: route.runtimeNodeId } : {}),
    status: route.status,
    credentialBoundary: route.credentialBoundary,
  };
}

export interface AgentAdapterRuntimeOptions {
  /** P1 rollout gate. The default is false and must remain false until a real adapter is ready. */
  enabled?: boolean;
  runtimeNodes?: readonly RuntimeNodeRef[];
  /** Read-only source projection for existing Desktop execution locations. */
  runtimeNodeSource?: () => RuntimeNodeSourceSnapshot;
  /** Optional local-only notification source; never installed while disabled. */
  runtimeNodeSourceSubscribe?: (onChanged: () => void) => () => void;
  existingProviderRoutes?: readonly ExistingProviderRouteRef[];
  defaultExistingProviderRouteId?: string;
  /** Built-ins are explicitly injected; the production default is an empty list. */
  agentAdapters?: readonly AgentAdapter[];
}

export interface AgentAdapterRuntime {
  readonly enabled: boolean;
  readonly signal: AbortSignal;
  readonly nodes: RuntimeNodeDirectory;
  readonly registry: AgentAdapterRegistry;
  listAdapterMetadata(): readonly AgentAdapterMetadata[];
  listAdapterStatuses(): readonly AgentAdapterStatusProjection[];
  /** Refresh the directory from the injected source, if one is configured. */
  refreshRuntimeNodes(): readonly RuntimeNodeRef[];
  /** Stop a live source subscription, if this runtime was created enabled. */
  dispose(): void;
  discover(): Promise<AgentAdapterDiscoveryResult>;
  /** Start an explicitly selected Agent after resolving its strict route. */
  start(request: AgentStartRequest): Promise<AgentSession>;
  catalog(): UnifiedRouteCatalog;
  resolve(request: UnifiedRouteRequest): UnifiedRoute;
}

export function createAgentAdapterRuntime(
  options: AgentAdapterRuntimeOptions = {},
): AgentAdapterRuntime {
  const runtimeNodeSource = options.runtimeNodeSource;
  // Keep source reads lazy. In particular, constructing the inert runtime
  // must not initialize an SSH pool while the legacy Maker is starting.
  const initialNodes = options.runtimeNodes ?? [{ id: 'local', kind: 'local', status: 'online' }];
  const nodes = new RuntimeNodeDirectory(initialNodes);
  const registry = new AgentAdapterRegistry(nodes, options.enabled === true);
  for (const adapter of options.agentAdapters ?? []) registry.registerAgentAdapter(adapter);
  let agentInstances: readonly AgentInstanceRef[] = [];
  let officialApiAccounts: readonly OfficialApiAccountRef[] = [];
  let unsubscribeRuntimeNodeSource: (() => void) | null = null;
  let disposed = false;
  let discovery: Promise<AgentAdapterDiscoveryResult> | null = null;
  const lifetime = new AbortController();
  const sessions = new Set<AgentSession>();
  const assertLive = () => {
    if (disposed) throw new Error('Agent adapter runtime is disposed');
  };
  const refreshRuntimeNodes = (): readonly RuntimeNodeRef[] => {
    assertLive();
    if (runtimeNodeSource && registry.enabled)
      nodes.replace(projectRuntimeNodes(runtimeNodeSource()));
    return nodes.list();
  };
  const onRuntimeNodeSourceChanged = (): void => {
    if (disposed) return;
    // A malformed or transient source snapshot must not break the Device Link
    // presence handler; keep the last valid directory until the next change.
    try {
      refreshRuntimeNodes();
    } catch {
      // The source is best-effort and has no user-visible error channel in P1.
    }
  };
  if (registry.enabled && runtimeNodeSource && options.runtimeNodeSourceSubscribe) {
    unsubscribeRuntimeNodeSource = options.runtimeNodeSourceSubscribe(onRuntimeNodeSourceChanged);
  }
  const catalog = (): UnifiedRouteCatalog => {
    const knownNodeIds = new Set(nodes.list().map((node) => node.id));
    return {
      runtimeNodes: nodes.list(),
      agentInstances: agentInstances.filter((instance) => knownNodeIds.has(instance.runtimeNodeId)),
      officialApiAccounts: officialApiAccounts.filter(
        (account) => !account.runtimeNodeId || knownNodeIds.has(account.runtimeNodeId),
      ),
      existingProviderRoutes: (options.existingProviderRoutes ?? []).map(copyExistingProviderRoute),
      ...(options.defaultExistingProviderRouteId
        ? { defaultExistingProviderRouteId: options.defaultExistingProviderRouteId }
        : {}),
    };
  };

  return {
    enabled: registry.enabled,
    signal: lifetime.signal,
    nodes,
    registry,
    listAdapterMetadata: () => registry.listAdapterMetadata(),
    listAdapterStatuses: () => registry.listAdapterStatuses(),
    refreshRuntimeNodes,
    dispose() {
      disposed = true;
      lifetime.abort();
      unsubscribeRuntimeNodeSource?.();
      unsubscribeRuntimeNodeSource = null;
      for (const session of sessions) void session.close().catch(() => {});
      sessions.clear();
    },
    async discover() {
      assertLive();
      if (discovery) return discovery;
      refreshRuntimeNodes();
      discovery = registry
        .discover()
        .then((result) => {
          assertLive();
          agentInstances = result.agentInstances;
          officialApiAccounts = result.officialApiAccounts;
          return result;
        })
        .finally(() => {
          discovery = null;
        });
      return discovery;
    },
    async start(request) {
      assertLive();
      refreshRuntimeNodes();
      resolveUnifiedRoute(
        {
          sessionId: request.sessionId,
          target: { kind: 'agent-native', agentInstanceId: request.instanceId },
          runtimeNodeId: request.runtimeNodeId,
          ...(request.workspace ? { workspace: request.workspace } : {}),
        },
        catalog(),
      );
      const session = await registry.startAgent({
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, lifetime.signal])
          : lifetime.signal,
      });
      if (disposed || request.signal?.aborted) {
        await session.close();
        throw new Error('Agent adapter start was cancelled');
      }
      const tracked: AgentSession = {
        ...session,
        async close() {
          sessions.delete(tracked);
          await session.close();
        },
      };
      sessions.add(tracked);
      return tracked;
    },
    catalog: () => {
      assertLive();
      if (runtimeNodeSource && registry.enabled)
        nodes.replace(projectRuntimeNodes(runtimeNodeSource()));
      return catalog();
    },
    resolve: (request) => resolveUnifiedRoute(request, catalog()),
  };
}
