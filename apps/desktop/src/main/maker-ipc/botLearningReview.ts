import { buildBotMemoryScopeKey } from '@cindy/maker-core';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { drainPersistQueue, enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { patchMessageAgentMetaWithResult } from '../localDb/ipc/messages.js';
import { learningReceiptPublisher } from './botLearningFeedback.js';
import {
  hasLearningEvidence,
  learningSnapshotBudget,
  learningSnapshotPrefix,
  learningReviewInstructions,
  learningReviewSchema,
} from './botLearningReviewPlan.js';
import { listBotSkills, readBotSkill } from './botSkillStore.js';
import { saveBotSkillForSession } from './botSkillService.js';
import { requestBotRuntimeEpochRefresh } from './botRuntimeEpochRefreshSignal.js';
import {
  applyWorkingMemoryProposal,
  readBotWorkingMemory,
  workingMemoryForReview,
  writeBotWorkingMemory,
} from './botWorkingMemory.js';

const running = new Map<string, Promise<void>>();
/** 本轮取材最多取多少条消息;超出即视为截断,水位不推进到当前回复。 */
const TURN_REVIEW_ROWS = 80;
/** 缺口回补每批最多取多少条消息 / 多少字符;单条正文已截到 6000 字,所以每批至少前进一条。 */
const GAP_BACKFILL_ROWS = 40;
const GAP_BACKFILL_CHARS = 16000;
const REVIEW_ROLES = `role IN ('user','assistant','tool_use','tool_result')`;
/** Once per durable successful reply; serial per teammate, outside the chat/agent loop. */
export async function reviewTeammateLearning(sessionId: string, replyId: string): Promise<void> {
  const owner = activeOwnerScopeKey();
  const db = getDbClient();
  const publish = learningReceiptPublisher(sessionId);
  const current = () =>
    !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner && getDbClient() === db;
  await drainPersistQueue();
  if (!current()) return;
  const readOwner = () =>
    db.queryOne<{ botId: string; capabilities: string; rowid: number; meta: string }>(
      `
    SELECT b.bot_id AS botId, v.capabilities_json AS capabilities, m.rowid, m.agent_meta AS meta
    FROM messages m JOIN sessions s ON s.id=m.session_id
    JOIN bot_session_links b ON b.session_id=s.id JOIN bot_profiles p ON p.id=b.bot_id
    JOIN bot_profile_versions v ON v.bot_id=p.id AND v.version=p.current_version
    WHERE m.session_id=? AND m.client_id=? AND m.role='assistant' AND m.rewind_at IS NULL
      AND b.role='canonical' AND b.archived_at IS NULL AND p.status='active' AND s.source='bot' AND s.status='active'
      AND s.remote_host_id IS NULL AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
  `,
      [sessionId, replyId],
    );
  const row = await readOwner();
  if (!current() || !row) return;
  const meta = JSON.parse(row.meta || '{}');
  if (
    meta.turnCompleted !== true ||
    meta.botLearningReviewed ||
    meta.parentUuid ||
    meta.botPrivateReply ||
    meta.botGroupLane
  )
    return;
  // Claim before awaiting the model. Restart/replayed terminals must not spend or write twice.
  const claimed = await enqueueDurableWrite(`learning-review:${sessionId}:${replyId}`, async () => {
    if (!current()) return false;
    const latest = await readOwner();
    if (!latest || JSON.parse(latest.meta || '{}').botLearningReviewed) return false;
    return !!(await patchMessageAgentMetaWithResult(sessionId, replyId, {
      botLearningReviewed: true,
    }));
  });
  if (!claimed) return;
  const key = `${owner}:${row.botId}`;
  const job = (running.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!current() || !(await readOwner())) return;
      const root = ownerScopedUserDataPath();
      // 工作记忆账本随同一次复盘维护(不另起模型调用);读不到按空账本,写入 CAS 失败放弃本轮。
      const workingBefore = await readBotWorkingMemory(root, row.botId);
      type Record_ = { id: string; role: string; content: string; order: number };
      const toSnapshot = (m: Record_) => ({
        id: m.id,
        role: m.role,
        order: m.order,
        text: (typeof JSON.parse(m.content) === 'string' ? JSON.parse(m.content) : m.content).slice(0, 6000),
      });
      // /clear 之前的消息始终不取。
      const clearedAtFilter = `AND created_at > COALESCE((SELECT cleared_at FROM sessions WHERE id=?), 0)`;
      const prev = await db.queryOne<{ id: string; rowid: number }>(
        `SELECT client_id AS id, rowid FROM messages WHERE session_id=? AND rowid < ? AND rewind_at IS NULL
         AND role='assistant' AND json_valid(agent_meta) AND json_extract(agent_meta, '$.turnCompleted')=1
         ORDER BY rowid DESC LIMIT 1 /* prev-completed */`,
        [sessionId, row.rowid],
      );
      const prevCompleted = prev?.rowid ?? 0;
      // 本轮取材:上一条完成回复之后到当前回复。
      const records = await db.query<Record_>(
        `
      SELECT client_id AS id, role, content, rowid AS 'order' FROM messages
      WHERE session_id=? AND rewind_at IS NULL AND rowid <= ? AND rowid > ? ${clearedAtFilter}
      AND ${REVIEW_ROLES} ORDER BY CASE WHEN role='user' THEN 0 ELSE 1 END, rowid DESC LIMIT ${TURN_REVIEW_ROWS}
    `,
        [sessionId, row.rowid, prevCompleted, sessionId],
      );
      const turnMessages = learningSnapshotBudget(records.map(toSnapshot), 40000);
      // 本轮本身被 LIMIT / 预算截断(工具密集的大轮次)时,漏掉的中间承诺 / 工具结果同样不能
      // 算"已覆盖":水位停在上一条完成回复,下一次复盘由缺口回补路径按序补齐。
      const turnTruncated = records.length >= TURN_REVIEW_ROWS || turnMessages.length < records.length;
      // 缺口回补:账本上次覆盖到的行落后于上一条完成回复(某轮复盘 claim 后失败、CAS 冲突、
      // 模型漏回 working),那段内容不会再被单独复盘;按 rowid 升序分批补进本次取材,覆盖水位
      // 只推进到连续处理过的前缀末尾——补不完就不推进到当前回复,账本在补完前不算新鲜,换窗线
      // 不会因为一份有缺口的账本提前。每批有界且至少前进一条,几轮即收敛。
      //
      // 水位的持久判据是消息 client_id(rowid 在瘦身 VACUUM 后可能重排),按它解析回当前 rowid;
      // 解析不到(水位消息被删 / 撤回)退回存下的 rowid。没有账本(老对话第一次建账本、或首轮
      // 复盘 claim 后失败)时从对话开头(/clear 之后)起算:整段历史按缺口分批回补,补完之前
      // 不算新鲜,不跳过任何一轮。
      type Watermark = { rowid: number; id: string | undefined };
      const floor: Watermark = workingBefore
        ? {
            rowid:
              (workingBefore.coveredThroughMessageId
                ? (
                    await db.queryOne<{ rowid: number }>(
                      `SELECT rowid FROM messages WHERE session_id=? AND client_id=? /* ledger-floor */`,
                      [sessionId, workingBefore.coveredThroughMessageId],
                    )
                  )?.rowid
                : undefined) ?? workingBefore.coveredThroughRowid,
            id: workingBefore.coveredThroughMessageId,
          }
        : { rowid: 0, id: undefined };
      let covered: Watermark = turnTruncated ? { rowid: prevCompleted, id: prev?.id } : { rowid: row.rowid, id: replyId };
      let gapMessages: ReturnType<typeof toSnapshot>[] = [];
      if (floor.rowid < prevCompleted) {
        const gapRows = await db.query<Record_>(
          `
      SELECT client_id AS id, role, content, rowid AS 'order' FROM messages
      WHERE session_id=? AND rewind_at IS NULL AND rowid > ? AND rowid <= ? ${clearedAtFilter}
      AND ${REVIEW_ROLES} ORDER BY rowid ASC LIMIT ?
    `,
          [sessionId, floor.rowid, prevCompleted, sessionId, GAP_BACKFILL_ROWS + 1],
        );
        gapMessages = learningSnapshotPrefix(gapRows.slice(0, GAP_BACKFILL_ROWS).map(toSnapshot), GAP_BACKFILL_CHARS);
        if (gapRows.length > GAP_BACKFILL_ROWS || gapMessages.length < gapRows.length) {
          const last = gapMessages[gapMessages.length - 1];
          covered = last ? { rowid: last.order, id: last.id } : floor;
        }
      }
      const messages = [...gapMessages, ...turnMessages].sort((a, b) => a.order - b.order);
      if (!messages.some((m) => m.role === 'user') || !current()) return;
      const [{ getMaker }, { requestUtilityText }] = await Promise.all([
        import('../maker-host/index.js'),
        import('../utility-model/oneShotCandidates.js'),
      ]);
      if (!current()) return;
      const maker = getMaker();
      const config = JSON.parse((await readOwner())?.capabilities || '{}');
      const store =
        config.memory !== false
          ? await maker.makerMemory?.getStore(buildBotMemoryScopeKey(row.botId))
          : undefined;
      const memories = store
        ? (await store.list()).filter((m) =>
            ['user', 'feedback', 'project', 'reference'].includes(m.frontmatter.type),
          )
        : [];
      if (!current()) return;
      const catalog = await listBotSkills(root, row.botId);
      const skills = (
        await Promise.all(
          catalog
            .filter((s) => s.enabled !== false)
            .slice(0, 40)
            .map((s) => readBotSkill(root, row.botId, s.slug)),
        )
      ).filter((s) => s !== null);
      // Incomplete bodies must never be used as replacements for existing records.
      const memorySnapshot = learningSnapshotBudget(
        memories.filter((m) => m.body.length <= 12000),
        24000,
      );
      const skillSnapshot = learningSnapshotBudget(
        skills.filter((s) => s.body.length <= 12000),
        24000,
      );
      if (!current()) return;
      const memoryIndex = memories.map((m) => ({
        name: m.slug,
        type: m.frontmatter.type,
        title: m.frontmatter.title,
      }));
      const skillIndex = catalog.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
        enabled: s.enabled,
      }));
      if (JSON.stringify({ memoryIndex, skillIndex }).length > 24000) return;
      const result = await requestUtilityText(
        maker,
        JSON.stringify({
          messages,
          workingMemory: workingMemoryForReview(workingBefore),
          memoryEnabled: !!store,
          memoryIndex,
          memories: memorySnapshot.map((m) => ({ name: m.slug, ...m.frontmatter, body: m.body })),
          skillIndex,
          skills: skillSnapshot.map((s) => ({
            slug: s.slug,
            title: s.name,
            description: s.description,
            body: s.body,
          })),
        }),
        {
          systemPrompt: learningReviewInstructions,
          maxTokens: 6000,
          timeoutMs: 45000,
          validateResponse: (text) => {
            try {
              return learningReviewSchema.safeParse(JSON.parse(text)).success;
            } catch {
              return false;
            }
          },
          beforeDispatch: async () => current() && !!(await readOwner()),
        },
      );
      if (!result.ok || !current()) return;
      const plan = learningReviewSchema.parse(JSON.parse(result.text));
      if (plan.working && (await readOwner())) {
        try {
          await writeBotWorkingMemory(
            root,
            row.botId,
            applyWorkingMemoryProposal(workingBefore, plan.working, messages, {
              now: Date.now(),
              coveredThroughRowid: covered.rowid,
              ...(covered.id ? { coveredThroughMessageId: covered.id } : {}),
            }),
            workingBefore?.revision ?? 0,
          );
        } catch {
          /* 版本冲突或写盘失败:保留磁盘上的版本,下一次复盘再合并。 */
        }
      }
      let memorySaved = false;
      for (const proposal of plan.memories) {
        if (!current()) return;
        const latest = await readOwner();
        if (!latest || JSON.parse(latest.capabilities || '{}').memory === false) break;
        if (!store || !hasLearningEvidence(proposal, messages, true)) continue;
        const filename = `${proposal.type}_${proposal.name}.md`;
        const prior = memories.find((m) => m.filename === filename);
        if (prior && !memorySnapshot.includes(prior)) continue;
        if (prior?.body === proposal.body) continue;
        try {
          if (prior)
            await store.update(filename, prior.frontmatter.updatedAt, {
              title: proposal.title,
              description: proposal.description,
              body: proposal.body,
            });
          else await store.write({ ...proposal, mode: 'create' });
          memorySaved = true;
          if (current())
            publish(replyId, [
              {
                kind: 'memory',
                key: filename,
                title: proposal.title,
                action: prior ? 'updated' : 'created',
              },
            ]);
        } catch {
          /* A concurrent edit wins; never overwrite or claim a failed save. */
        }
      }
      for (const proposal of plan.skills) {
        if (!current() || !(await readOwner())) return;
        if (!hasLearningEvidence(proposal, messages, false)) continue;
        const prior = catalog.find((s) => s.slug === proposal.slug);
        const snapshot = skillSnapshot.find((s) => s.slug === proposal.slug);
        if (prior && (!snapshot || prior.enabled === false)) continue;
        if (snapshot?.body === proposal.body) continue;
        const saved = await saveBotSkillForSession({
          callerSessionId: sessionId,
          slug: proposal.slug,
          name: proposal.title,
          description: proposal.description,
          body: proposal.body,
          expectedUpdatedAt: prior?.updatedAt ?? null,
        });
        if (saved.ok && current())
          publish(replyId, [
            {
              kind: 'skill',
              key: saved.skill.slug,
              title: saved.skill.name,
              action: saved.created ? 'created' : 'updated',
            },
          ]);
      }
      if (memorySaved && current()) await requestBotRuntimeEpochRefresh(sessionId, 'resource');
    });
  running.set(key, job);
  try {
    await job;
  } finally {
    if (running.get(key) === job) running.delete(key);
  }
}
