/** Personal records belong to the executing host's account database. */
export type PluginUsageOutcome = 'unknown' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled';

export interface PluginUsageSummary {
  subjectId: string;
  recordingStartedAt: number;
  lastUsedAt: number | null;
  callsLast7Days: number;
  totalCalls: number;
  until: number;
  deviceName: string;
  recentTasks: { sessionId: string; title: string; lastUsedAt: number }[];
}

/** Host-verified source, never supplied by a plugin or renderer. */
export interface PluginUsageIdentity {
  ghostId: string;
  displayName: string;
  revision: string;
  sourceKind: 'server' | 'git-market' | 'local-market' | 'manual';
  stableKey: string | null;
  pluginId: string | null;
  organizationId: string | null;
  sourceKey: string | null;
  serverRoot: string | null;
  version: string | null;
  releaseId: string | null;
}

export interface PluginUsageHandle {
  subjectId: string;
  historyGeneration: number;
  identity: PluginUsageIdentity;
}

export type PluginUsageTransaction =
  | {
      action: 'bind';
      identity: PluginUsageIdentity;
      newId: string;
      now: number;
      previousRevision?: string;
    }
  | {
      action: 'accept';
      handle: PluginUsageHandle;
      callId: string;
      toolName: string;
      sessionId: string | null;
      occurredAt: number;
    }
  | { action: 'settle'; handle: PluginUsageHandle; callId: string; outcome: PluginUsageOutcome }
  | { action: 'clear'; subjectId: string | null; now: number }
  | { action: 'detach'; ghostId: string };
