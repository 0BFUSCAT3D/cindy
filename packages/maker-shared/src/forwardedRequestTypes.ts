/** Host-owned source evidence. It describes authorship, never execution permission. */
export interface ForwardedRequestSource {
  userText: string | null;
  sessionId?: string;
  clientId?: string;
}

/** Kept under the existing protected, non-human input receipt. */
export interface AgentRequestReceipt {
  kind: 'agent-request' | 'delegated-continuation';
  request?: ForwardedRequestSource;
}

