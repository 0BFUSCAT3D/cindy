/**
 * hook-control/defaultRouteFollow.ts
 * ---------------------------------------------------------------------------
 * 官方 hook(官方 Telegram / Slack / X)任务「跟随默认」的 hook 侧零件。
 *
 * 判定、切换与一次性提示与个人 IM 渠道同一套(im/shared/channelDefaultRouteSync 的
 * createDefaultRouteFollower); 这里只放 hook 自己的部分:
 *
 *   - 哪些任务归它管: 官方 hook 建的本机活跃任务。它们没有个人渠道的标记列, 认
 *     跟随记录; 本功能之前建的 Telegram / X 任务(sessions.source 落了渠道名)没有
 *     记录, 在下一条消息时按值认领(当前路由就是此刻的默认才开始跟随)。
 *   - 建任务时记下它是按哪一版默认建的(与个人渠道建任务写记录同语义)。
 *   - 提示怎么送到渠道: hook 没有「另发一条消息」的通道, 附在这一轮回复末尾。
 *
 * 「默认」= 新任务取值链: 工作目录偏好 > IM 默认(见 session-runner 的
 * resolveNewSessionConfig)。权限档不跟随。
 */
import { eq } from 'drizzle-orm';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { buildImDefaultRouteRecord } from '../im/shared/channelDefaultRoute.js';
import type { SessionRouteRow } from '../im/shared/channelDefaultRouteSync.js';

/** 官方 hook 跟随默认管得着的任务。 */
export function isHookDefaultRouteRow(row: SessionRouteRow): boolean {
  if (row.status !== 'active' || row.remoteHostId || row.orcaRole || !row.model) return false;
  // 个人渠道的任务归个人渠道自己的跟随(按渠道设置), 不归这里。
  if (row.imBotContextId || row.feishuBotAppId) return false;
  // 有记录 = 官方 hook 建的(或已经认领过的); 没记录的只认官方 Telegram / X 建的老任务
  // —— 被接管的桌面任务不该开始跟随 IM 默认。
  return row.imDefaultRoute !== null || row.source === 'telegram' || row.source === 'x';
}

/**
 * 新任务建好、来源落库之后记下「按哪一版默认建的」—— 读回库里的实际路由(系统
 * 可能钉住来源 / 校正档位)。已有记录不覆盖; 行还不在(落库失败)就不记, 下一条消息
 * 按值认领。尽力而为, 失败只影响以后跟不跟随, 不影响这一轮。
 */
export async function writeHookDefaultRouteRecord(sessionId: string, fingerprint: string): Promise<void> {
  const db = getDbClient();
  const [row] = await db.drizzle
    .select({
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      effort: sessions.effort,
      imDefaultRoute: sessions.imDefaultRoute,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row?.model || row.imDefaultRoute !== null) return;
  await db.drizzle
    .update(sessions)
    .set({
      imDefaultRoute: buildImDefaultRouteRecord(fingerprint, {
        agentKind: dbToMakerAgentKind(row.agentKind),
        model: row.model,
        providerId: row.providerId?.trim() || null,
        effort: row.effort ?? null,
      }),
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * 把一次性提示附在这一轮回复(或失败说明)末尾。放末尾而不是开头: 答案仍是主体,
 * 失败说明的开头也保持原样(dispatcher 按开头给失败归类)。
 */
export function appendDefaultRouteNotice(text: string, notice: string | null): string {
  if (!notice) return text;
  const body = text.trimEnd();
  return body ? `${body}\n\n${notice}` : notice;
}
