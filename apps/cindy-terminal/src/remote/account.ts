import { createProviderShareApi, createSharedTaskApi } from '@cindy/device-link';
import { TerminalRemoteError } from './types.js';

export interface TerminalRemoteAccountOptions {
  getApiBaseUrl(): string;
  getAuthBaseUrl?(): string;
  getToken(): Promise<string | null>;
  /** Includes account, home region and generation; null is signed out. */
  getOwnerScope(): string | null;
  fetch?: typeof fetch;
}

/** Reuses the exact cross-device management protocol and response parsers.
 * This is a local owner API, never a guest-callable device-link channel. */
export class TerminalRemoteAccountService {
  readonly sharedTasks: ReturnType<typeof createSharedTaskApi>;
  readonly providerShares: ReturnType<typeof createProviderShareApi>;


  async identityCard(purpose: 'share-link' | 'share-request' | 'share-session', nonce: string): Promise<string> {
    const owner = this.options.getOwnerScope();
    const check = () => { if (!owner || owner !== this.options.getOwnerScope()) throw new TerminalRemoteError('OWNER_CHANGED', 'Remote account changed'); };
    check();
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('INVALID_IDENTITY_NONCE');
    const token = await this.options.getToken(); check();
    if (!token) throw new Error('AUTH_REQUIRED');
    const url = new URL('/api/me/identity-card', this.options.getAuthBaseUrl?.() ?? this.options.getApiBaseUrl());
    const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: 'cindy-provider-share', purpose, nonce }) });
    check(); if (!response.ok) throw new Error('PROVIDER_SHARE_IDENTITY_INVALID');
    const value = await response.json() as { card?: unknown }; check();
    if (typeof value.card !== 'string' || !value.card || value.card.length > 8192) throw new Error('PROVIDER_SHARE_IDENTITY_INVALID');
    return value.card;
  }

  constructor(private readonly options: TerminalRemoteAccountOptions) {
    const api = {
      captureScope: () => {
        const owner = options.getOwnerScope();
        return { isCurrent: () => owner !== null && options.getOwnerScope() === owner };
      },
      request: async (path: string, request: { method: 'GET' | 'POST'; body?: unknown; isCurrent(): boolean }) => {
        const check = () => {
          if (!request.isCurrent()) throw new TerminalRemoteError('OWNER_CHANGED', 'Remote account changed');
        };
        check();
        if (!path.startsWith('/api/device-link/')) throw new TerminalRemoteError('INVALID_ENDPOINT', 'Invalid account endpoint');
        const url = new URL(path, options.getApiBaseUrl());
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TerminalRemoteError('INVALID_ENDPOINT', 'Invalid account endpoint');
        const token = await options.getToken(); check();
        if (!token) throw new TerminalRemoteError('AUTH_REQUIRED', 'Sign in to manage remote access');
        const response = await (options.fetch ?? fetch)(url, {
          method: request.method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        });
        check();
        if (!response.ok) throw new TerminalRemoteError(response.status === 401 ? 'AUTH_REQUIRED' : 'REMOTE_API_ERROR', 'Remote account operation failed');
        const value: unknown = await response.json(); check(); return value;
      },
    };
    this.sharedTasks = createSharedTaskApi(api);
    this.providerShares = createProviderShareApi(api);
  }
}
