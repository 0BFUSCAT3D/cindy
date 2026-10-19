import { and, eq } from 'drizzle-orm';

import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';
import type { FeishuToolTransport } from '../im/shared/channelToolScope.js';

type Caller = { sessionId?: string; sessionInstanceId?: string } | undefined;

/** Resolve each notification against the current account and live connection.
 * No negative cache: a session can acquire its canonical link after creation.
 */
export function createFeishuTransportResolver(deps: {
  readTurnScope: (session: Caller) => { im: FeishuToolTransport } | null;
  getCompanionTransport: (botId: string, ownerOpenId?: string) => FeishuToolTransport | null;
  personalIm: FeishuToolTransport;
}) {
  return async (session: Caller, ownerOpenId?: string): Promise<FeishuToolTransport> => {
    const scope = deps.readTurnScope(session);
    if (scope) return scope.im;
    if (!session?.sessionId) return deps.personalIm;

    const snapshot = getCurrentDbClientSnapshot();
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
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('Feishu account changed');
    if (!row?.botId) return deps.personalIm;
    const im = deps.getCompanionTransport(row.botId, ownerOpenId);
    if (!im) throw new Error('Companion Feishu connection unavailable');
    return im;
  };
}
