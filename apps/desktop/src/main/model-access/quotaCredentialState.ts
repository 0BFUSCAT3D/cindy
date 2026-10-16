import type { AuthState } from '../authManager.js';
import type { ModelAccessStatus } from '../../shared/modelAccess.js';

// Process-local readiness only: persisted credentials never count as a successful
// sync in this process. No keys or endpoint values leave the main process.
let owner: string | null = null;
let endpoint: string | null = null;
let ready = false;
let generation = 0;
const listeners = new Set<(ownerKey: string | null) => void>();

export function noteQuotaCredentialStatus(ownerKey: string | null, status: ModelAccessStatus): void {
  const nextEndpoint = status.endpoint?.trim().replace(/\/+$/, '') || null;
  const reset = owner !== ownerKey || status.state === 'idle';
  const changed = status.state === 'ok' && endpoint !== nextEndpoint;
  if (reset) endpoint = null;
  owner = ownerKey;
  ready = status.state === 'ok' && status.source === 'server' && !!nextEndpoint;
  if (ready) endpoint = nextEndpoint;
  if (reset || changed) {
    generation++;
    for (const listener of listeners) listener(ownerKey);
  }
}

export function quotaCredentialsReady(ownerKey: string, effectiveEndpoint: string): boolean {
  return ready && owner === ownerKey && endpoint === effectiveEndpoint.trim().replace(/\/+$/, '');
}
export function quotaCredentialGeneration(): number { return generation; }
export function onQuotaCredentialSourceChanged(listener: (ownerKey: string | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Owner generation also fences same-membership realm switches and repairs. */
export function cloudQuotaOwnerKey(auth: Pick<AuthState, 'mode' | 'dataOwnerId' | 'ownerGeneration'>): string | null {
  return auth.mode === 'cloud' && auth.dataOwnerId
    ? `cloud:${auth.dataOwnerId}:${auth.ownerGeneration}` : null;
}
