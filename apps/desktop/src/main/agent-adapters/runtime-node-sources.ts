import type { RuntimeNodeRef, RuntimeNodeStatus } from '@cindy/maker-core/agent-adapters';

export interface DeviceLinkRuntimeNodeSnapshot {
  deviceId: string;
  label?: string;
  platform?: string | null;
  online: boolean;
  /** False means the existing Device Link control path is currently unavailable. */
  available?: boolean;
  /** Existing responsiveness circuit breaker is open for this peer. */
  unresponsive?: boolean;
}

export type SshRuntimeNodeStatus =
  'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'reconnecting' | 'failed';

export interface SshRuntimeNodeSnapshot {
  hostId: string;
  label?: string;
  status: SshRuntimeNodeStatus;
}

export interface RuntimeNodeSourceSnapshot {
  local?: RuntimeNodeRef;
  deviceLinks?: readonly DeviceLinkRuntimeNodeSnapshot[];
  sshHosts?: readonly SshRuntimeNodeSnapshot[];
}

export interface DesktopRuntimeNodeSourceDependencies {
  /** Read-only snapshot of the current Desktop process/runtime host. */
  getLocalNode?: () => RuntimeNodeRef;
  getDeviceLinks: () => readonly DeviceLinkRuntimeNodeSnapshot[];
  getSshHosts: () => readonly SshRuntimeNodeSnapshot[];
}

const DESKTOP_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

function isDesktopPlatform(platform: string | null | undefined): boolean {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform);
}

export function mapSshRuntimeNodeStatus(status: SshRuntimeNodeStatus): RuntimeNodeStatus {
  if (status === 'ready') return 'online';
  if (status === 'connecting' || status === 'authenticating' || status === 'reconnecting') {
    return 'degraded';
  }
  return 'offline';
}

function projectDeviceNode(device: DeviceLinkRuntimeNodeSnapshot): RuntimeNodeRef | null {
  if (!device.deviceId || !isDesktopPlatform(device.platform)) return null;
  return {
    id: `device:${device.deviceId}`,
    kind: 'cindy-device',
    status: !device.online
      ? 'offline'
      : device.available === false || device.unresponsive === true
        ? 'degraded'
        : 'online',
    label: device.label ?? device.deviceId,
  };
}

function projectSshNode(host: SshRuntimeNodeSnapshot): RuntimeNodeRef {
  return {
    id: `ssh:${host.hostId}`,
    kind: 'ssh',
    status: mapSshRuntimeNodeStatus(host.status),
    label: host.label ?? host.hostId,
  };
}

/**
 * Convert existing execution-location snapshots into the P1 runtime-node
 * contract. This is a pure projection: it does not connect, spawn, or read
 * credentials from any source.
 */
export function projectRuntimeNodes(snapshot: RuntimeNodeSourceSnapshot): RuntimeNodeRef[] {
  const nodes: RuntimeNodeRef[] = [
    snapshot.local ?? { id: 'local', kind: 'local', status: 'online' },
  ];

  for (const device of snapshot.deviceLinks ?? []) {
    const node = projectDeviceNode(device);
    if (node) nodes.push(node);
  }
  for (const host of snapshot.sshHosts ?? []) {
    if (!host.hostId) continue;
    const node = projectSshNode(host);
    nodes.push(node);
  }

  return nodes;
}

/**
 * Build the Desktop source reader without importing Device Link or SSH
 * lifecycle code into the generic Agent Adapter runtime.
 */
export function createDesktopRuntimeNodeSource(
  dependencies: DesktopRuntimeNodeSourceDependencies,
): () => RuntimeNodeSourceSnapshot {
  return () => ({
    // Keep the fallback for callers/tests that have not adopted the local
    // host probe yet. Desktop main supplies getLocalNode in the live path.
    local: dependencies.getLocalNode?.() ?? { id: 'local', kind: 'local', status: 'online' },
    deviceLinks: dependencies.getDeviceLinks(),
    sshHosts: dependencies.getSshHosts(),
  });
}
