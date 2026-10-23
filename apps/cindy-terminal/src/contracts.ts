/** Local transport exposes the same application channels as device-link. */
export interface TerminalClient {
  invoke<T = unknown>(channel: string, args?: unknown[], deviceId?: string): Promise<T>;
  subscribe(listener: (channel: string, args: unknown[]) => void): () => void;
  close(): void;
}

export interface TerminalSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface InvocationContext {
  source: 'local' | 'remote';
  /** Verified from the relay's scoped source and an authoritative membership snapshot. */
  sharedTask?: { sharedTaskId: string; sessionId: string; memberId: string; accountId: string; name?: string };
  deviceId?: string;
  /** Assigned by the authenticated host, never accepted from command arguments. */
  ownerId?: string;
  signal?: AbortSignal;
  /** Reject stale requests before mutations or publishing asynchronous results. */
  assertCurrent?: () => void;
}

export type ChannelHandler = (args: unknown[], context: InvocationContext) => Promise<unknown>;
