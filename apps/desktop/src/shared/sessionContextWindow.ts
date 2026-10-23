import type { Catalog } from '@cindy/model-providers';
import { dbToMakerAgentKind } from './agentKindConversion';

/** Route identity carried by both persisted sessions and their renderer projection. */
export interface ContextWindowSession {
  agentKind?: string | null;
  model?: string | null;
  providerId?: string | null;
}

export { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';
import { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';

/** Codex and Pi report their effective runtime windows; catalogs cannot replace them. */
export function resolveSessionContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  session: ContextWindowSession,
): number | null {
  if (!session.model || session.agentKind === 'pi' || session.agentKind === 'codex') return null;
  return resolveVerifiedContextWindow(
    catalog,
    dbToMakerAgentKind(session.agentKind),
    session.providerId,
    session.model,
  );
}

/** Preserve proven runtime budgets; legacy catalog snapshots retain read-time correction. */
export function projectSessionContextWindow<
  T extends ContextWindowSession & { contextWindow: number; contextWindowRuntime?: number | null },
>(session: T, resolve?: (session: ContextWindowSession) => number | null): T {
  if (Number.isFinite(session.contextWindow) && session.contextWindow > 0 &&
      session.contextWindowRuntime === session.contextWindow) return session;
  const window = resolve?.(session);
  return window && Number.isFinite(window) && window > 0 && window !== session.contextWindow
    ? { ...session, contextWindow: window }
    : session;
}
