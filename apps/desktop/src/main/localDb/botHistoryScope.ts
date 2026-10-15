import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('bot-history-scope');

export type BotHistoryScope =
  | { kind: 'unscoped' }
  | { kind: 'bot'; botId: string }
  | { kind: 'denied' };

/**
 * Resolve history ownership from host-owned runtime attribution.
 * A Bot memory scope must never fall back to account-wide history when the
 * Session id is missing or its ownership link is damaged.
 */
export async function resolveBotHistoryScope(
  callerSessionId: string | undefined,
  callerMemoryScopeKey: string | undefined,
): Promise<BotHistoryScope> {
  if (!callerSessionId) {
    return callerMemoryScopeKey?.startsWith('bot:') ? { kind: 'denied' } : { kind: 'unscoped' };
  }
  const row = await getDbClient().queryOne<{ source: string; botId: string | null }>(
    `SELECT s.source AS source,
            bsl.bot_id AS botId
       FROM sessions s
       LEFT JOIN bot_session_links bsl ON bsl.session_id = s.id
      WHERE s.id = ?
      LIMIT 1`,
    [callerSessionId],
  );
  if (!row) return { kind: 'denied' };
  if (row.source !== 'bot') return { kind: 'unscoped' };
  if (!row.botId) {
    log.warn('Bot Session is missing its ownership link', { sessionId: callerSessionId });
    return { kind: 'denied' };
  }
  return { kind: 'bot', botId: row.botId };
}

export async function resolveBotHistorySessionIds(
  callerSessionId: string | undefined,
  callerMemoryScopeKey: string | undefined,
): Promise<string[] | null> {
  const scope = await resolveBotHistoryScope(callerSessionId, callerMemoryScopeKey);
  if (scope.kind === 'unscoped') return null;
  if (scope.kind === 'denied') return [];
  // The Bot's own sessions plus the background tasks it started (ordinary
  // `desktop` sessions without a bot_session_links row).
  const rows = await getDbClient().query<{ sessionId: string }>(
    `SELECT sessionId FROM (
       SELECT session_id AS sessionId, created_at AS createdAt
         FROM bot_session_links
        WHERE bot_id = ?
       UNION
       SELECT child_session_id AS sessionId, created_at AS createdAt
         FROM bot_delegations
        WHERE requesting_bot_id = ? AND child_session_id IS NOT NULL
     )
     ORDER BY createdAt DESC`,
    [scope.botId, scope.botId],
  );
  return [...new Set(rows.map((row) => row.sessionId))];
}

/**
 * 换窗交接回忆指引用的伙伴自有会话清单(有界,最多 `limit` 条)。按归属分层而不是按时间混排:
 * 伙伴自己的对话会话(当前主对话 + 恢复前的 history Session,最新在前)整体优先,剩余名额再
 * 给最新的后台任务——后台任务再多,结果也早已按回执进过主对话;而旧对话一旦被挤出清单,
 * 用户追问恢复前的事就只能得到"没有记录"。非伙伴会话或归属损坏返回 []。
 */
export async function listBotRecallSessionIds(callerSessionId: string, limit: number): Promise<string[]> {
  const scope = await resolveBotHistoryScope(callerSessionId, undefined);
  if (scope.kind !== 'bot' || limit <= 0) return [];
  const db = getDbClient();
  const chats = await db.query<{ sessionId: string }>(
    `SELECT session_id AS sessionId FROM bot_session_links
      WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?`,
    [scope.botId, limit],
  );
  const ids = new Set(chats.map((row) => row.sessionId));
  const remaining = limit - ids.size;
  if (remaining > 0) {
    const tasks = await db.query<{ sessionId: string }>(
      `SELECT child_session_id AS sessionId FROM bot_delegations
        WHERE requesting_bot_id = ? AND child_session_id IS NOT NULL
        ORDER BY created_at DESC LIMIT ?`,
      [scope.botId, remaining],
    );
    for (const row of tasks) ids.add(row.sessionId);
  }
  return [...ids];
}

/**
 * 这个伙伴的队友们 —— 除它自己之外、还启用着的伙伴。
 *
 * 给提示词里的队友名册用(见 buildBotTeammateRoster):委派能力开着却不告诉伙伴
 * 队友是谁,那条能力基本不会被触发 —— 模型没有任何理由想到去调 `list_bots`,
 * 因为提示词里一个队友的名字都没出现过。
 *
 * 只列 active 的:归档/停用的伙伴委派过去也跑不起来,列出来就是空头支票。
 * 按名字排序,让同一批伙伴在不同会话里渲染出**逐字节相同**的名册 —— 名册在
 * 易变层,顺序抖动会平白打断前缀缓存。
 */
export async function listBotTeammates(input: {
  excludeBotId: string;
}): Promise<{ id: string; name: string; description?: string | null }[]> {
  const rows = await getDbClient().query<{
    id: string;
    name: string;
    description: string | null;
  }>(
    `SELECT id, display_name AS name, description
       FROM bot_profiles
      WHERE id <> ?
        AND status = 'active'
      ORDER BY display_name ASC`,
    [input.excludeBotId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
  }));
}
