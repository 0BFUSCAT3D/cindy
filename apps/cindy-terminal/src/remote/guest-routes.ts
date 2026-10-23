import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Short-lived capabilities stay inside this process. A replacement run cannot
 * release its successor's grant and a closed owner cannot authorize a request. */
export class TerminalGuestRoutes {
  private readonly owner: string | null;
  private readonly routes = new Map<string, { providerId: string; token: string; allows(model: string): Promise<boolean> }>();
  private closed = false;
  constructor(private readonly scope: () => string | null) { this.owner = scope(); }
  register(sessionId: string, providerId: string, allows: (model: string) => Promise<boolean>, _restricted: () => boolean) {
    if (this.closed || this.scope() !== this.owner) throw new Error('OWNER_CHANGED');
    const binding = { providerId, token: randomBytes(32).toString('base64url'), allows };
    this.routes.set(sessionId, binding);
    return { token: binding.token, release: () => { if (this.routes.get(sessionId) === binding) this.routes.delete(sessionId); } };
  }
  async check(input: { sessionId: string; providerId: string; routeToken: string; model: string }): Promise<boolean> {
    if (this.closed || this.owner === null || this.scope() !== this.owner) return false;
    const binding = this.routes.get(input.sessionId);
    if (!binding || binding.providerId !== input.providerId || typeof input.routeToken !== 'string') return false;
    const supplied = Buffer.from(input.routeToken);
    const expected = Buffer.from(binding.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    try {
      const allowed = await binding.allows(input.model);
      return allowed && !this.closed && this.scope() === this.owner && this.routes.get(input.sessionId) === binding;
    } catch { return false; }
  }
  async modelAllowed(providerId: string, model: string, sessionId: string): Promise<boolean> {
    const binding = this.routes.get(sessionId);
    return !!binding && this.check({ sessionId, providerId, model, routeToken: binding.token });
  }
  close() { this.closed = true; this.routes.clear(); }
}
