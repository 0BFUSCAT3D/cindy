import { and, eq } from 'drizzle-orm';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';
import type { FeishuToolTransport } from '../im/shared/channelToolScope.js';

type Caller = { sessionId?: string; sessionInstanceId?: string } | undefined;
type ResolvedTransport = { im: FeishuToolTransport; assertCurrent: () => void };

/** Resolve each notification against the current account and live connection.
 * No negative cache: a session can acquire its canonical link after creation.
 */
export function createFeishuTransportResolver(deps: {
  readTurnScope: (session: Caller) => { im: FeishuToolTransport } | null;
  getCompanionTransport: (botId: string, ownerOpenId?: string) => FeishuToolTransport | null;
  personalIm: FeishuToolTransport;
}) {
  return async (session: Caller, ownerOpenId?: string): Promise<ResolvedTransport> => {
    const ownerScope = activeOwnerScopeKey();
    let snapshot: CurrentDbClientSnapshot | null = null;
    // Teardown marks the boundary pending before replacing the DB or stopping IM.
    // Callers must also check after awaiting this resolver, immediately before use.
    const assertCurrent = () => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScope ||
          (snapshot && getCurrentDbClientSnapshot() !== snapshot)) {
        throw new Error('Feishu account changed');
      }
    };
    assertCurrent();
    const scope = deps.readTurnScope(session);
    if (scope) return { im: scope.im, assertCurrent };
    if (!session?.sessionId) return { im: deps.personalIm, assertCurrent };

    snapshot = getCurrentDbClientSnapshot();
    if (!snapshot) throw new Error('DbClient not ready');
    const row = await snapshot.client.drizzle
      .select({ botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(and(
        eq(botSessionLinks.sessionId, session.sessionId),
        eq(sessions.source, 'bot'),
        eq(botSessionLinks.role, 'canonical'),
      ))
      .limit(1)
      .get();
    assertCurrent();
    if (!row?.botId) return { im: deps.personalIm, assertCurrent };
    const im = deps.getCompanionTransport(row.botId, ownerOpenId);
    if (!im) throw new Error('Companion Feishu connection unavailable');
    return { im, assertCurrent };
  };
}
