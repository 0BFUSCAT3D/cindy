/**
 * External Agent / official API routing contracts.
 *
 * This module deliberately contains references and capabilities only. It must never contain
 * raw API keys, OAuth tokens, browser cookies, or serialized credential files.
 */

export type AgentAdapterKind = 'agent-native' | 'official-api';

/**
 * Static, non-secret facts about an adapter. This is intentionally separate
 * from discovered instances/accounts: an adapter may be registered before a
 * product is installed or logged in on any runtime node.
 */
export interface AgentAdapterMetadata {
  id: string;
  kind: AgentAdapterKind;
  displayName: string;
  credentialBoundary: 'agent-owned' | 'official-api';
  capabilities: readonly string[];
}

export type RuntimeNodeKind = 'local' | 'cindy-device' | 'ssh' | 'cloud';

export type RuntimeNodeStatus = 'online' | 'offline' | 'degraded';

export interface RuntimeNodeRef {
  id: string;
  kind: RuntimeNodeKind;
  status: RuntimeNodeStatus;
  label?: string;
}

export interface WorkspaceRef {
  id: string;
  runtimeNodeId: string;
  root: string;
}

export type AgentInstanceStatus =
  | 'ready'
  | 'busy'
  | 'offline'
  | 'needs-auth'
  | 'unsupported';

/** A concrete, already-discovered Agent runtime. Credentials remain in that Agent runtime. */
export interface AgentInstanceRef {
  id: string;
  adapterId: string;
  displayName: string;
  runtimeNodeId: string;
  status: AgentInstanceStatus;
  credentialBoundary: 'agent-owned';
  capabilities: readonly string[];
}

export type OfficialApiAccountStatus = 'ready' | 'offline' | 'needs-auth' | 'unsupported';

/** An official API connection. The credential itself is owned by the existing provider host. */
export interface OfficialApiAccountRef {
  id: string;
  adapterId: string;
  providerId: string;
  displayName: string;
  runtimeNodeId?: string;
  status: OfficialApiAccountStatus;
  credentialBoundary: 'official-api';
  capabilities: readonly string[];
}

export type ExistingProviderRouteStatus = 'ready' | 'offline' | 'needs-auth' | 'unsupported';

/** Compatibility projection of the existing Cindy provider route. */
export interface ExistingProviderRouteRef {
  id: string;
  providerId: string;
  runtimeNodeId?: string;
  status: ExistingProviderRouteStatus;
  credentialBoundary: 'existing-provider';
}

export type UnifiedRouteTarget =
  | { kind: 'agent-native'; agentInstanceId: string }
  | { kind: 'official-api'; accountId: string }
  | { kind: 'existing-provider'; routeId: string };

export interface UnifiedRouteRequest {
  sessionId: string;
  /** Omitted means legacy/default behavior and must resolve only the existing provider route. */
  target?: UnifiedRouteTarget;
  runtimeNodeId?: string;
  workspace?: WorkspaceRef;
}

export interface UnifiedRouteCatalog {
  runtimeNodes: readonly RuntimeNodeRef[];
  agentInstances: readonly AgentInstanceRef[];
  officialApiAccounts: readonly OfficialApiAccountRef[];
  existingProviderRoutes: readonly ExistingProviderRouteRef[];
  /** The route selected by the existing provider resolver for legacy sessions. */
  defaultExistingProviderRouteId?: string;
}

export type UnifiedRoute =
  | {
      kind: 'agent-native';
      adapterId: string;
      agentInstanceId: string;
      runtimeNodeId: string;
      workspace?: WorkspaceRef;
      credentialBoundary: 'agent-owned';
    }
  | {
      kind: 'official-api';
      adapterId: string;
      accountId: string;
      providerId: string;
      runtimeNodeId?: string;
      workspace?: WorkspaceRef;
      credentialBoundary: 'official-api';
    }
  | {
      kind: 'existing-provider';
      routeId: string;
      providerId: string;
      runtimeNodeId?: string;
      workspace?: WorkspaceRef;
      credentialBoundary: 'existing-provider';
    };

export type UnifiedRouteErrorCode =
  | 'default-route-missing'
  | 'target-not-found'
  | 'target-unavailable'
  | 'runtime-node-missing'
  | 'runtime-node-unavailable'
  | 'workspace-runtime-mismatch'
  | 'credential-boundary-invalid';

export class UnifiedRouteError extends Error {
  readonly name = 'UnifiedRouteError';

  constructor(
    readonly code: UnifiedRouteErrorCode,
    message: string,
    readonly sessionId?: string,
  ) {
    super(message);
  }
}

export interface AgentStartRequest {
  sessionId: string;
  instanceId: string;
  runtimeNodeId: string;
  workspace?: WorkspaceRef;
  /** Host lifecycle only; never serialized into a remote request. */
  signal?: AbortSignal;
}

export interface AgentAdapterEvent {
  type: string;
  data?: unknown;
}

export interface AgentSession {
  readonly instanceId: string;
  readonly runtimeNodeId: string;
  send(input: { text: string }): Promise<void>;
  onEvent(listener: (event: AgentAdapterEvent) => void): () => void;
  stop(): Promise<void>;
  close(): Promise<void>;
  /** Respond to an Agent-owned permission request; no credentials cross this boundary. */
  respondPermission?(requestId: string, optionId: string | null): Promise<void>;
}

/**
 * Adapter boundary for a product that owns its own Agent loop and login session.
 * No credential-returning method is intentionally present.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly kind: 'agent-native';
  /** Optional for backwards-compatible adapters; the host supplies a safe default. */
  readonly metadata?: AgentAdapterMetadata;
  discover(runtimeNode: RuntimeNodeRef): Promise<readonly AgentInstanceRef[]>;
  start(request: AgentStartRequest): Promise<AgentSession>;
}

/** Adapter boundary for a provider with an explicit official API/OAuth contract. */
export interface ProviderAdapter {
  readonly id: string;
  readonly kind: 'official-api';
  /** Optional for backwards-compatible adapters; the host supplies a safe default. */
  readonly metadata?: AgentAdapterMetadata;
  discover(runtimeNode: RuntimeNodeRef): Promise<readonly OfficialApiAccountRef[]>;
}
