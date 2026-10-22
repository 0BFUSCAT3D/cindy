import {
  UnifiedRouteError,
  type AgentInstanceRef,
  type ExistingProviderRouteRef,
  type OfficialApiAccountRef,
  type RuntimeNodeRef,
  type UnifiedRoute,
  type UnifiedRouteCatalog,
  type UnifiedRouteRequest,
  type WorkspaceRef,
} from './types.js';

function findRuntimeNode(catalog: UnifiedRouteCatalog, id: string): RuntimeNodeRef {
  const node = catalog.runtimeNodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new UnifiedRouteError('runtime-node-missing', 'Runtime node is not registered: ' + id);
  }
  if (node.status !== 'online') {
    throw new UnifiedRouteError('runtime-node-unavailable', 'Runtime node is not online: ' + id);
  }
  return node;
}

function validateWorkspace(
  catalog: UnifiedRouteCatalog,
  workspace: WorkspaceRef | undefined,
  runtimeNodeId: string,
): void {
  if (!workspace) return;
  if (workspace.runtimeNodeId !== runtimeNodeId) {
    throw new UnifiedRouteError(
      'workspace-runtime-mismatch',
      'Workspace ' + workspace.id + ' belongs to runtime node ' + workspace.runtimeNodeId + ', not ' + runtimeNodeId,
    );
  }
  findRuntimeNode(catalog, workspace.runtimeNodeId);
}

function assertAgentBoundary(instance: AgentInstanceRef): void {
  if (instance.credentialBoundary !== 'agent-owned') {
    throw new UnifiedRouteError(
      'credential-boundary-invalid',
      'Agent instance ' + instance.id + ' does not keep credentials in the Agent runtime',
    );
  }
}

function assertApiBoundary(account: OfficialApiAccountRef): void {
  if (account.credentialBoundary !== 'official-api') {
    throw new UnifiedRouteError(
      'credential-boundary-invalid',
      'API account ' + account.id + ' is not an official API connection',
    );
  }
}

function assertExistingBoundary(route: ExistingProviderRouteRef): void {
  if (route.credentialBoundary !== 'existing-provider') {
    throw new UnifiedRouteError(
      'credential-boundary-invalid',
      'Existing provider route ' + route.id + ' has an invalid credential boundary',
    );
  }
}

function assertTargetAvailable(
  status: AgentInstanceRef['status'] | OfficialApiAccountRef['status'] | ExistingProviderRouteRef['status'],
  id: string,
): void {
  if (status !== 'ready') {
    throw new UnifiedRouteError('target-unavailable', 'Route target is not ready: ' + id);
  }
}

function resolveAgentRoute(
  request: UnifiedRouteRequest,
  catalog: UnifiedRouteCatalog,
  agentInstanceId: string,
): UnifiedRoute {
  const instance = catalog.agentInstances.find((candidate) => candidate.id === agentInstanceId);
  if (!instance) {
    throw new UnifiedRouteError('target-not-found', 'Agent instance is not registered: ' + agentInstanceId);
  }
  assertAgentBoundary(instance);
  assertTargetAvailable(instance.status, instance.id);
  const runtimeNodeId = request.runtimeNodeId ?? instance.runtimeNodeId;
  if (runtimeNodeId !== instance.runtimeNodeId) {
    throw new UnifiedRouteError(
      'runtime-node-missing',
      'Agent instance ' + instance.id + ' is bound to runtime node ' + instance.runtimeNodeId,
    );
  }
  findRuntimeNode(catalog, runtimeNodeId);
  validateWorkspace(catalog, request.workspace, runtimeNodeId);
  return {
    kind: 'agent-native',
    adapterId: instance.adapterId,
    agentInstanceId: instance.id,
    runtimeNodeId,
    ...(request.workspace ? { workspace: request.workspace } : {}),
    credentialBoundary: 'agent-owned',
  };
}

function resolveApiRoute(
  request: UnifiedRouteRequest,
  catalog: UnifiedRouteCatalog,
  accountId: string,
): UnifiedRoute {
  const account = catalog.officialApiAccounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    throw new UnifiedRouteError('target-not-found', 'Official API account is not registered: ' + accountId);
  }
  assertApiBoundary(account);
  assertTargetAvailable(account.status, account.id);
  const runtimeNodeId = request.runtimeNodeId ?? account.runtimeNodeId;
  if (runtimeNodeId) {
    findRuntimeNode(catalog, runtimeNodeId);
    validateWorkspace(catalog, request.workspace, runtimeNodeId);
  }
  return {
    kind: 'official-api',
    adapterId: account.adapterId,
    accountId: account.id,
    providerId: account.providerId,
    ...(runtimeNodeId ? { runtimeNodeId } : {}),
    ...(request.workspace ? { workspace: request.workspace } : {}),
    credentialBoundary: 'official-api',
  };
}

function resolveExistingRoute(
  request: UnifiedRouteRequest,
  catalog: UnifiedRouteCatalog,
  routeId: string,
): UnifiedRoute {
  const route = catalog.existingProviderRoutes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw new UnifiedRouteError('target-not-found', 'Existing provider route is not registered: ' + routeId);
  }
  assertExistingBoundary(route);
  assertTargetAvailable(route.status, route.id);
  if (route.runtimeNodeId) {
    findRuntimeNode(catalog, route.runtimeNodeId);
    validateWorkspace(catalog, request.workspace, route.runtimeNodeId);
  }
  return {
    kind: 'existing-provider',
    routeId: route.id,
    providerId: route.providerId,
    ...(route.runtimeNodeId ? { runtimeNodeId: route.runtimeNodeId } : {}),
    ...(request.workspace ? { workspace: request.workspace } : {}),
    credentialBoundary: 'existing-provider',
  };
}

/**
 * Resolve a route without changing legacy defaults.
 *
 * An explicit target is strict: unavailable Agent/API targets never fall back to another
 * subscription or the existing provider route. An omitted target resolves only the route selected
 * by the existing provider resolver.
 */
export function resolveUnifiedRoute(
  request: UnifiedRouteRequest,
  catalog: UnifiedRouteCatalog,
): UnifiedRoute {
  if (request.target?.kind === 'agent-native') {
    return resolveAgentRoute(request, catalog, request.target.agentInstanceId);
  }
  if (request.target?.kind === 'official-api') {
    return resolveApiRoute(request, catalog, request.target.accountId);
  }
  if (request.target?.kind === 'existing-provider') {
    return resolveExistingRoute(request, catalog, request.target.routeId);
  }

  const defaultRouteId = catalog.defaultExistingProviderRouteId;
  if (!defaultRouteId) {
    throw new UnifiedRouteError('default-route-missing', 'The existing provider route has no default');
  }
  return resolveExistingRoute(request, catalog, defaultRouteId);
}
