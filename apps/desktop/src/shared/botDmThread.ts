/**
 * 私聊话题（docs/product-rules/cindy-bots-runtime.md「私聊话题」）。
 *
 * 主人在与伙伴的私聊里对某条消息开话题：宿主为「这条消息 × 这位伙伴」另开一条隐藏 Session，
 * `bot_session_links.role = 'thread'`，`route_key = 'dm-thread:<根消息所在 Session>:<根消息 clientId>'`。
 * 话题 Session 与主任务同一 Profile、Home、模型链与权限档，只有上下文是自己的。
 */

export const BOT_DM_THREAD_ROUTE_PREFIX = 'dm-thread:';

/** clientId 与 Session id 都不含冒号；含冒号的输入不构成合法话题。 */
const ROUTE_PART = /^[^:\s]{1,128}$/;

export function botDmThreadRouteKey(rootSessionId: string, rootClientId: string): string {
  if (!ROUTE_PART.test(rootSessionId) || !ROUTE_PART.test(rootClientId)) {
    throw new Error('Invalid private-chat topic root');
  }
  return `${BOT_DM_THREAD_ROUTE_PREFIX}${rootSessionId}:${rootClientId}`;
}

export function parseBotDmThreadRouteKey(
  routeKey: string | null | undefined,
): { rootSessionId: string; rootClientId: string } | null {
  if (!routeKey?.startsWith(BOT_DM_THREAD_ROUTE_PREFIX)) return null;
  const [rootSessionId, rootClientId, ...rest] = routeKey.slice(BOT_DM_THREAD_ROUTE_PREFIX.length).split(':');
  if (rest.length > 0 || !rootSessionId || !rootClientId) return null;
  if (!ROUTE_PART.test(rootSessionId) || !ROUTE_PART.test(rootClientId)) return null;
  return { rootSessionId, rootClientId };
}

/** One private-chat topic as the chat timeline shows it under its root message. */
export interface BotDmThreadSummary {
  /** The topic's hidden Session. */
  sessionId: string;
  rootSessionId: string;
  rootClientId: string;
  /** Visible user and companion messages in the topic. */
  replyCount: number;
  /** Latest visible message in the topic (ms), or null while it has none. */
  lastReplyAt: number | null;
  /** Latest companion reply in the topic (ms); the timeline compares it with the read position. */
  lastAssistantAt: number | null;
  createdAt: number;
}
