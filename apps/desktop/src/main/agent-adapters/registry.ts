import type {
  AgentAdapter,
  AgentAdapterMetadata,
  AgentInstanceRef,
  AgentSession,
  AgentStartRequest,
  OfficialApiAccountRef,
  ProviderAdapter,
  RuntimeNodeRef,
} from '@cindy/maker-core/agent-adapters';

import { RuntimeNodeDirectory } from './runtime-node-directory.js';

export interface AgentAdapterDiscoveryFailure {
  adapterId: string;
  runtimeNodeId: string;
  message: string;
}

export interface AgentAdapterDiscoveryResult {
  agentInstances: readonly AgentInstanceRef[];
  officialApiAccounts: readonly OfficialApiAccountRef[];
  failures: readonly AgentAdapterDiscoveryFailure[];
}

export type AgentAdapterAvailabilityStatus = 'disabled' | 'offline' | 'degraded' | 'ready';

/** Safe registry projection for future Desktop/Mobile surfaces. */
export interface AgentAdapterStatusProjection {
  metadata: AgentAdapterMetadata;
  status: AgentAdapterAvailabilityStatus;
  runtimeNodeIds: readonly string[];
  discoveredInstanceIds: readonly string[];
  discoveredAccountIds: readonly string[];
  failureCount: number;
}

export class AgentAdapterRegistryError extends Error {
  readonly name = 'AgentAdapterRegistryError';

  constructor(
    readonly code:
      | 'duplicate-agent-adapter'
      | 'duplicate-provider-adapter'
      | 'kind-mismatch'
      | 'agent-not-discovered'
      | 'agent-unavailable'
      | 'adapter-disabled',
    message: string,
  ) {
    super(message);
  }
}

interface AgentAdapterRegistration {
  adapter: AgentAdapter;
  metadata: AgentAdapterMetadata;
}

interface ProviderAdapterRegistration {
  adapter: ProviderAdapter;
  metadata: AgentAdapterMetadata;
}

interface DiscoveryState {
  discoveredInstances: Array<{ id: string; runtimeNodeId: string }>;
  discoveredAccounts: Array<{ id: string; runtimeNodeId: string }>;
  failureCount: number;
}

interface DiscoveredAgent {
  adapter: AgentAdapter;
  instance: AgentInstanceRef;
}

function copyAgentInstance(instance: AgentInstanceRef): AgentInstanceRef {
  return {
    id: instance.id,
    adapterId: instance.adapterId,
    displayName: instance.displayName,
    runtimeNodeId: instance.runtimeNodeId,
    status: instance.status,
    credentialBoundary: instance.credentialBoundary,
    capabilities: [...new Set(instance.capabilities)],
  };
}

function copyApiAccount(account: OfficialApiAccountRef): OfficialApiAccountRef {
  return {
    id: account.id,
    adapterId: account.adapterId,
    providerId: account.providerId,
    displayName: account.displayName,
    ...(account.runtimeNodeId !== undefined ? { runtimeNodeId: account.runtimeNodeId } : {}),
    status: account.status,
    credentialBoundary: account.credentialBoundary,
    capabilities: [...new Set(account.capabilities)],
  };
}

function copyMetadata(metadata: AgentAdapterMetadata): AgentAdapterMetadata {
  return {
    id: metadata.id,
    kind: metadata.kind,
    displayName: metadata.displayName,
    credentialBoundary: metadata.credentialBoundary,
    capabilities: [...metadata.capabilities],
  };
}

function expectedCredentialBoundary(
  kind: AgentAdapterMetadata['kind'],
): AgentAdapterMetadata['credentialBoundary'] {
  return kind === 'agent-native' ? 'agent-owned' : 'official-api';
}

function defaultMetadata(adapter: AgentAdapter | ProviderAdapter): AgentAdapterMetadata {
  return {
    id: adapter.id,
    kind: adapter.kind,
    displayName: adapter.id,
    credentialBoundary: expectedCredentialBoundary(adapter.kind),
    capabilities: [],
  };
}

function normalizeMetadata(
  adapter: AgentAdapter | ProviderAdapter,
  supplied?: AgentAdapterMetadata,
): AgentAdapterMetadata {
  const candidate = supplied ?? adapter.metadata ?? defaultMetadata(adapter);
  if (
    candidate.id !== adapter.id ||
    candidate.kind !== adapter.kind ||
    candidate.credentialBoundary !== expectedCredentialBoundary(adapter.kind) ||
    typeof candidate.displayName !== 'string' ||
    candidate.displayName.trim().length === 0 ||
    !Array.isArray(candidate.capabilities) ||
    candidate.capabilities.some(
      (capability) => typeof capability !== 'string' || capability.trim().length === 0,
    )
  ) {
    throw new AgentAdapterRegistryError(
      'kind-mismatch',
      'Adapter metadata does not match adapter boundary: ' + adapter.id,
    );
  }
  return copyMetadata({
    ...candidate,
    capabilities: [...new Set(candidate.capabilities)],
  });
}

function isOnline(node: RuntimeNodeRef): boolean {
  return node.status === 'online';
}

const AGENT_INSTANCE_STATUSES = new Set<AgentInstanceRef['status']>([
  'ready',
  'busy',
  'offline',
  'needs-auth',
  'unsupported',
]);
const OFFICIAL_API_ACCOUNT_STATUSES = new Set<OfficialApiAccountRef['status']>([
  'ready',
  'offline',
  'needs-auth',
  'unsupported',
]);

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Adapter returned an invalid ${field}`);
  }
}

function assertCapabilities(value: unknown): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((capability) => typeof capability !== 'string' || capability.trim().length === 0)
  ) {
    throw new Error('Adapter returned invalid capabilities');
  }
}

function validateAgentInstance(
  instance: AgentInstanceRef,
  adapterId: string,
  runtimeNodeId: string,
  seenIds: Set<string>,
): void {
  assertNonEmptyString(instance.id, 'instance id');
  assertNonEmptyString(instance.adapterId, 'adapter id');
  assertNonEmptyString(instance.displayName, 'instance display name');
  assertNonEmptyString(instance.runtimeNodeId, 'instance runtime node id');
  if (instance.adapterId !== adapterId || instance.runtimeNodeId !== runtimeNodeId) {
    throw new Error(`Adapter ${adapterId} returned an instance bound to another adapter or node`);
  }
  if (instance.credentialBoundary !== 'agent-owned') {
    throw new Error(`Adapter ${adapterId} returned an invalid Agent credential boundary`);
  }
  if (!AGENT_INSTANCE_STATUSES.has(instance.status)) {
    throw new Error(`Adapter ${adapterId} returned an invalid Agent status`);
  }
  assertCapabilities(instance.capabilities);
  if (seenIds.has(instance.id)) {
    throw new Error(`Adapter ${adapterId} returned a duplicate Agent instance id`);
  }
  seenIds.add(instance.id);
}

function validateApiAccount(
  account: OfficialApiAccountRef,
  adapterId: string,
  runtimeNodeId: string,
  seenIds: Set<string>,
): void {
  assertNonEmptyString(account.id, 'account id');
  assertNonEmptyString(account.adapterId, 'account adapter id');
  assertNonEmptyString(account.providerId, 'account provider id');
  assertNonEmptyString(account.displayName, 'account display name');
  if (account.adapterId !== adapterId) {
    throw new Error(`Adapter ${adapterId} returned an account bound to another adapter`);
  }
  if (account.runtimeNodeId !== undefined && account.runtimeNodeId !== runtimeNodeId) {
    throw new Error(`Adapter ${adapterId} returned an account bound to another node`);
  }
  if (account.credentialBoundary !== 'official-api') {
    throw new Error(`Adapter ${adapterId} returned an invalid official API credential boundary`);
  }
  if (!OFFICIAL_API_ACCOUNT_STATUSES.has(account.status)) {
    throw new Error(`Adapter ${adapterId} returned an invalid official API account status`);
  }
  assertCapabilities(account.capabilities);
  if (seenIds.has(account.id)) {
    throw new Error(`Adapter ${adapterId} returned a duplicate official API account id`);
  }
  seenIds.add(account.id);
}

/**
 * Adapter registry owned by Desktop main.
 *
 * `enabled` is an explicit rollout gate. When false, adapters remain
 * uncalled and no discovery result is exposed. Existing provider routing does
 * not depend on this registry.
 */
export class AgentAdapterRegistry {
  private readonly agentAdapters = new Map<string, AgentAdapterRegistration>();
  private readonly providerAdapters = new Map<string, ProviderAdapterRegistration>();
  private discoveryState = new Map<string, DiscoveryState>();
  private discoveredAgents = new Map<string, DiscoveredAgent>();

  constructor(
    private readonly nodeDirectory: RuntimeNodeDirectory,
    readonly enabled = false,
  ) {}

  registerAgentAdapter(adapter: AgentAdapter, metadata?: AgentAdapterMetadata): void {
    if (adapter.kind !== 'agent-native') {
      throw new AgentAdapterRegistryError(
        'kind-mismatch',
        `Agent adapter has invalid kind: ${adapter.id}`,
      );
    }
    if (this.agentAdapters.has(adapter.id)) {
      throw new AgentAdapterRegistryError(
        'duplicate-agent-adapter',
        `Agent adapter is already registered: ${adapter.id}`,
      );
    }
    this.agentAdapters.set(adapter.id, { adapter, metadata: normalizeMetadata(adapter, metadata) });
  }

  registerProviderAdapter(adapter: ProviderAdapter, metadata?: AgentAdapterMetadata): void {
    if (adapter.kind !== 'official-api') {
      throw new AgentAdapterRegistryError(
        'kind-mismatch',
        `Provider adapter has invalid kind: ${adapter.id}`,
      );
    }
    if (this.providerAdapters.has(adapter.id)) {
      throw new AgentAdapterRegistryError(
        'duplicate-provider-adapter',
        `Provider adapter is already registered: ${adapter.id}`,
      );
    }
    this.providerAdapters.set(adapter.id, {
      adapter,
      metadata: normalizeMetadata(adapter, metadata),
    });
  }

  listAgentAdapterIds(): readonly string[] {
    return [...this.agentAdapters.keys()];
  }

  listProviderAdapterIds(): readonly string[] {
    return [...this.providerAdapters.keys()];
  }

  listAgentAdapterMetadata(): readonly AgentAdapterMetadata[] {
    return [...this.agentAdapters.values()].map(({ metadata }) => copyMetadata(metadata));
  }

  listProviderAdapterMetadata(): readonly AgentAdapterMetadata[] {
    return [...this.providerAdapters.values()].map(({ metadata }) => copyMetadata(metadata));
  }

  listAdapterMetadata(): readonly AgentAdapterMetadata[] {
    return [...this.listAgentAdapterMetadata(), ...this.listProviderAdapterMetadata()];
  }

  /**
   * Project adapter health without exposing adapter objects, stderr, or
   * credentials. Discovery state is only a refinement of the node snapshot;
   * it never starts an adapter or reads a login session.
   */
  listAdapterStatuses(): readonly AgentAdapterStatusProjection[] {
    const onlineNodeIds = this.enabled
      ? this.nodeDirectory
          .list()
          .filter(isOnline)
          .map(({ id }) => id)
      : [];
    const knownNodeIds = new Set(this.nodeDirectory.list().map(({ id }) => id));
    return this.listAdapterMetadata().map((metadata) => {
      const state = this.discoveryState.get(metadata.id);
      const status: AgentAdapterAvailabilityStatus = !this.enabled
        ? 'disabled'
        : onlineNodeIds.length === 0
          ? 'offline'
          : state?.failureCount
            ? 'degraded'
            : 'ready';
      return {
        metadata: copyMetadata(metadata),
        status,
        runtimeNodeIds: [...onlineNodeIds],
        discoveredInstanceIds: this.enabled
          ? (state?.discoveredInstances ?? [])
              .filter(({ runtimeNodeId }) => knownNodeIds.has(runtimeNodeId))
              .map(({ id }) => id)
          : [],
        discoveredAccountIds: this.enabled
          ? (state?.discoveredAccounts ?? [])
              .filter(({ runtimeNodeId }) => knownNodeIds.has(runtimeNodeId))
              .map(({ id }) => id)
          : [],
        failureCount: this.enabled ? (state?.failureCount ?? 0) : 0,
      };
    });
  }

  async discover(): Promise<AgentAdapterDiscoveryResult> {
    if (!this.enabled) {
      this.discoveryState = new Map();
      this.discoveredAgents = new Map();
      return { agentInstances: [], officialApiAccounts: [], failures: [] };
    }

    const agentInstances: AgentInstanceRef[] = [];
    const officialApiAccounts: OfficialApiAccountRef[] = [];
    const failures: AgentAdapterDiscoveryFailure[] = [];
    const discoveryState = new Map<string, DiscoveryState>();
    const discoveredAgents = new Map<string, DiscoveredAgent>();
    const seenAgentInstanceIds = new Set<string>();
    const seenApiAccountIds = new Set<string>();
    const onlineNodes = this.nodeDirectory.list().filter(isOnline);

    for (const node of onlineNodes) {
      for (const registration of this.agentAdapters.values()) {
        const adapter = registration.adapter;
        const state = discoveryState.get(adapter.id) ?? {
          discoveredInstances: [],
          discoveredAccounts: [],
          failureCount: 0,
        };
        discoveryState.set(adapter.id, state);
        try {
          const discovered = await adapter.discover(node);
          if (!Array.isArray(discovered))
            throw new Error(`Adapter ${adapter.id} returned an invalid discovery result`);
          // Validate into a batch-local set first. If one item is malformed or
          // duplicated, the whole adapter/node batch is discarded and must not
          // reserve IDs for a later valid node.
          const batchSeenAgentInstanceIds = new Set(seenAgentInstanceIds);
          const projected = discovered.map((instance) => {
            validateAgentInstance(instance, adapter.id, node.id, batchSeenAgentInstanceIds);
            return copyAgentInstance(instance);
          });
          for (const instance of projected) seenAgentInstanceIds.add(instance.id);
          for (const instance of projected) {
            agentInstances.push(instance);
            state.discoveredInstances.push({ id: instance.id, runtimeNodeId: node.id });
            discoveredAgents.set(instance.id, { adapter, instance });
          }
        } catch {
          // Discovery errors can originate in third-party CLIs. Keep the
          // registry result free of raw stderr and serialized error objects.
          failures.push({
            adapterId: adapter.id,
            runtimeNodeId: node.id,
            message: 'Adapter discovery failed',
          });
          state.failureCount += 1;
        }
      }
      for (const registration of this.providerAdapters.values()) {
        const adapter = registration.adapter;
        const state = discoveryState.get(adapter.id) ?? {
          discoveredInstances: [],
          discoveredAccounts: [],
          failureCount: 0,
        };
        discoveryState.set(adapter.id, state);
        try {
          const discovered = await adapter.discover(node);
          if (!Array.isArray(discovered))
            throw new Error(`Adapter ${adapter.id} returned an invalid discovery result`);
          const batchSeenApiAccountIds = new Set(seenApiAccountIds);
          const projected = discovered.map((account) => {
            validateApiAccount(account, adapter.id, node.id, batchSeenApiAccountIds);
            return copyApiAccount(account);
          });
          for (const account of projected) seenApiAccountIds.add(account.id);
          for (const account of projected) {
            officialApiAccounts.push(account);
            state.discoveredAccounts.push({ id: account.id, runtimeNodeId: node.id });
          }
        } catch {
          failures.push({
            adapterId: adapter.id,
            runtimeNodeId: node.id,
            message: 'Adapter discovery failed',
          });
          state.failureCount += 1;
        }
      }
    }

    this.discoveryState = discoveryState;
    this.discoveredAgents = discoveredAgents;
    return { agentInstances, officialApiAccounts, failures };
  }

  /** Start only an instance from the latest successful discovery snapshot. */
  async startAgent(request: AgentStartRequest): Promise<AgentSession> {
    if (!this.enabled) {
      throw new AgentAdapterRegistryError('adapter-disabled', 'Agent adapters are disabled');
    }
    const discovered = this.discoveredAgents.get(request.instanceId);
    if (!discovered) {
      throw new AgentAdapterRegistryError(
        'agent-not-discovered',
        'Agent instance is not in the latest discovery snapshot: ' + request.instanceId,
      );
    }
    if (
      discovered.instance.runtimeNodeId !== request.runtimeNodeId ||
      discovered.instance.status !== 'ready' ||
      !this.nodeDirectory.get(request.runtimeNodeId) ||
      this.nodeDirectory.get(request.runtimeNodeId)?.status !== 'online'
    ) {
      throw new AgentAdapterRegistryError(
        'agent-unavailable',
        'Agent instance is unavailable on runtime node: ' + request.instanceId,
      );
    }
    return discovered.adapter.start(request);
  }
}
