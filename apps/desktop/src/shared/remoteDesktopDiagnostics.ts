/** Local diagnostics only: never include request payloads, credentials or raw leases. */
export interface DesktopHeartbeatSample {
  /** Viewer request time includes queueing; it is not proof of a socket write. */
  requestedAt?: number;
  settledAt?: number;
  /** Host receipt time, never used for a locally timed-out viewer request. */
  receivedAt?: number;
  result?: string;
}

export class DesktopHeartbeatHistory {
  private samples: DesktopHeartbeatSample[] = [];

  add(sample: DesktopHeartbeatSample): DesktopHeartbeatSample {
    this.samples.push(sample);
    if (this.samples.length > 8) this.samples.shift();
    return sample;
  }

  snapshot(): DesktopHeartbeatSample[] {
    return this.samples.map((sample) => ({ ...sample }));
  }
}

const DIAGNOSTIC_CODES = new Set([
  'DESKTOP_LEASE_EXPIRED',
  'DESKTOP_STOPPED',
  'DESKTOP_VIEW_ONLY',
  'DESKTOP_CONNECTION_TIMEOUT',
  'DESKTOP_INPUT_UNAVAILABLE',
  'DESKTOP_INPUT_TIMEOUT',
  'DESKTOP_INPUT_BUSY',
  'DESKTOP_INPUT_UNSUPPORTED',
  'DESKTOP_BUSY',
  'DESKTOP_DISABLED',
  'DESKTOP_AUTHENTICATION_REQUIRED',
  'DESKTOP_UNAVAILABLE',
  'INVOKE_TIMEOUT',
  'BACKPRESSURE',
  'DEVICE_LINK_BUSY',
  'DEVICE_UNRESPONSIVE',
  'DEVICE_OFFLINE',
  'NOT_CONNECTED',
  'LINK_CLOSED',
  'LINK_NOT_OPEN',
  'PEER_RESET',
  'ACCESS_REVOKED',
  'CHANNEL_NOT_ALLOWED',
  'REMOTE_DISABLED',
]);

/** Exact allowlist: arbitrary error messages can contain private request data. */
export function desktopDiagnosticCode(value: unknown): string {
  const code = value instanceof Error ? value.message : value;
  return typeof code === 'string' && DIAGNOSTIC_CODES.has(code) ? code : 'UNKNOWN_ERROR';
}

/** Same truncated SHA-256 as Main, without exposing a lease through a new IPC. */
export async function desktopDiagnosticId(lease: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(lease));
  return Array.from(new Uint8Array(hash).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
