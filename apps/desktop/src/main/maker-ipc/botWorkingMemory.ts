/**
 * 伙伴工作记忆账本:宿主替伙伴记的一份小账——进行中的事、答应过的事、在等谁、
 * 用户最新纠正、刚完成什么。它解决的是"换窗 / 原生压缩之后伙伴看起来忘事":
 *
 *  - 原生压缩的摘要宿主拿不到,不知道它丢了什么;宿主换窗的交接只是最近几轮摘录。
 *    两条路径都没有一份宿主自己掌握的语义状态。
 *  - 账本由回复后的学习复盘(botLearningReview,同伙伴串行、用户已配置的辅助模型)
 *    顺手维护,不新增模型调用;只在换窗交接和原生压缩后各注入一次,平时不占窗口。
 *
 * 分工:账本只存语义状态(线索 / 承诺 / 等待 / 纠正 / 近期完成)。后台任务状态、改动
 * 文件这类"宿主有真相"的内容在渲染时从数据库和消息现读,不信模型写的文本。
 *
 * 存储:`<ownerRoot>/bots/<botId>/working-memory.json`,与 SOUL / memories 同属 Bot Home;
 * 写入同目录临时文件再 rename(同 botProfileFolder 的原子写),revision 做 CAS。
 * 账本是摘要,不是授权:历史授权不是新的执行许可,注入文本里明说。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { botSkillRootDir } from './botSkillStore.js';

export const WORKING_MEMORY_FILE = 'working-memory.json';
export const WORKING_MEMORY_VERSION = 1;

/** 各区条数上限;超出时丢最旧的。 */
export const WORKING_MEMORY_LIMITS = {
  threads: 8,
  commitments: 10,
  waiting: 6,
  corrections: 8,
  recentlyDone: 8,
} as const;
/** 单条正文上限(字符)。 */
export const WORKING_MEMORY_ITEM_CHARS = 240;
/** 渲染成交接段落的总预算(字符)。 */
export const WORKING_MEMORY_RENDER_BUDGET = 6_000;

export interface WorkingMemoryItem {
  id: string;
  text: string;
  /** 产生这条记录的消息(用户或伙伴原话),模型可据此用历史工具拉原文。 */
  messageId?: string;
  updatedAt: number;
}
export interface WorkingThread extends WorkingMemoryItem {
  status: 'active' | 'waiting' | 'blocked';
  next?: string;
}
export interface WorkingCommitment extends WorkingMemoryItem {
  trigger?: string;
}
export interface WorkingWait extends WorkingMemoryItem {
  on: 'user' | 'external';
}
export interface WorkingCorrection extends WorkingMemoryItem {
  supersedes?: string;
}

export interface BotWorkingMemory {
  version: typeof WORKING_MEMORY_VERSION;
  /** CAS 版本号,每次成功写入 +1。 */
  revision: number;
  /** 语义层已经读过的最后一条消息 rowid;换窗线是否能提前取决于它是否覆盖最近完成轮。 */
  coveredThroughRowid: number;
  updatedAt: number;
  threads: WorkingThread[];
  commitments: WorkingCommitment[];
  waiting: WorkingWait[];
  corrections: WorkingCorrection[];
  recentlyDone: WorkingMemoryItem[];
}

export function emptyWorkingMemory(): BotWorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    revision: 0,
    coveredThroughRowid: 0,
    updatedAt: 0,
    threads: [],
    commitments: [],
    waiting: [],
    corrections: [],
    recentlyDone: [],
  };
}

export function workingMemoryPath(userDataDir: string, botId: string): string {
  return path.join(botSkillRootDir(userDataDir, botId), WORKING_MEMORY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampText(value: unknown, cap = WORKING_MEMORY_ITEM_CHARS): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, cap) : '';
}

function readItem(value: unknown): WorkingMemoryItem | null {
  if (!isRecord(value)) return null;
  const text = clampText(value.text);
  if (!text) return null;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `wm_${Math.random().toString(36).slice(2, 10)}`,
    text,
    ...(typeof value.messageId === 'string' && value.messageId ? { messageId: value.messageId } : {}),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** 容错解析:坏文件 / 旧版本按空账本处理,不让一份损坏的 JSON 卡住伙伴。 */
export function parseWorkingMemory(raw: unknown): BotWorkingMemory {
  const empty = emptyWorkingMemory();
  if (!isRecord(raw) || raw.version !== WORKING_MEMORY_VERSION) return empty;
  const list = <T extends WorkingMemoryItem>(key: keyof BotWorkingMemory, cap: number, extend: (item: WorkingMemoryItem, src: Record<string, unknown>) => T): T[] => {
    const source = Array.isArray(raw[key]) ? (raw[key] as unknown[]) : [];
    const out: T[] = [];
    for (const entry of source) {
      const base = readItem(entry);
      if (!base) continue;
      out.push(extend(base, entry as Record<string, unknown>));
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    ...empty,
    revision: typeof raw.revision === 'number' && raw.revision >= 0 ? Math.floor(raw.revision) : 0,
    coveredThroughRowid: typeof raw.coveredThroughRowid === 'number' && raw.coveredThroughRowid >= 0 ? Math.floor(raw.coveredThroughRowid) : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    threads: list('threads', WORKING_MEMORY_LIMITS.threads, (item, src) => ({
      ...item,
      status: src.status === 'waiting' || src.status === 'blocked' ? src.status : 'active',
      ...(clampText(src.next) ? { next: clampText(src.next) } : {}),
    })),
    commitments: list('commitments', WORKING_MEMORY_LIMITS.commitments, (item, src) => ({
      ...item,
      ...(clampText(src.trigger, 120) ? { trigger: clampText(src.trigger, 120) } : {}),
    })),
    waiting: list('waiting', WORKING_MEMORY_LIMITS.waiting, (item, src) => ({
      ...item,
      on: src.on === 'external' ? 'external' : 'user',
    })),
    corrections: list('corrections', WORKING_MEMORY_LIMITS.corrections, (item, src) => ({
      ...item,
      ...(clampText(src.supersedes) ? { supersedes: clampText(src.supersedes) } : {}),
    })),
    recentlyDone: list('recentlyDone', WORKING_MEMORY_LIMITS.recentlyDone, (item) => item),
  };
}

export async function readBotWorkingMemory(userDataDir: string, botId: string): Promise<BotWorkingMemory | null> {
  try {
    const raw = await fs.readFile(workingMemoryPath(userDataDir, botId), 'utf8');
    return parseWorkingMemory(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 坏 JSON 等同没有账本;下一次复盘会重建,不抛给调用方。
    return null;
  }
}

export class WorkingMemoryRevisionConflict extends Error {
  constructor() {
    super('working memory revision conflict');
    this.name = 'WorkingMemoryRevisionConflict';
  }
}

let writeSeq = 0;

/**
 * CAS 写入:磁盘上的 revision 必须等于 expectedRevision(没有文件时为 0),否则拒绝。
 * 同一主进程内按伙伴串行(学习复盘已串行),这里的 CAS 防的是接管 / 并发复盘等少见竞争。
 */
export async function writeBotWorkingMemory(
  userDataDir: string,
  botId: string,
  next: Omit<BotWorkingMemory, 'revision' | 'version'>,
  expectedRevision: number,
): Promise<BotWorkingMemory> {
  const target = workingMemoryPath(userDataDir, botId);
  const current = await readBotWorkingMemory(userDataDir, botId);
  if ((current?.revision ?? 0) !== expectedRevision) throw new WorkingMemoryRevisionConflict();
  const stored: BotWorkingMemory = {
    ...parseWorkingMemory({ ...next, version: WORKING_MEMORY_VERSION, revision: expectedRevision }),
    revision: expectedRevision + 1,
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${(writeSeq += 1)}`;
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (cause) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw cause;
  }
  return stored;
}

/** 账本是否已覆盖到给定消息行(语义层新鲜度;换窗线提前的判据)。 */
export function isWorkingMemoryFresh(memory: BotWorkingMemory | null, latestCompletedReplyRowid: number): boolean {
  return !!memory && memory.coveredThroughRowid >= latestCompletedReplyRowid;
}

// ── 模型提案 → 账本 ────────────────────────────────────────────────────────────

export interface WorkingMemoryEvidence {
  messageId: string;
  quote: string;
}
interface ProposedItem {
  text: string;
  evidence?: WorkingMemoryEvidence;
}
/** 学习复盘里模型返回的 `working` 字段(schema 见 botLearningReviewPlan)。 */
export interface WorkingMemoryProposal {
  threads: Array<ProposedItem & { status?: 'active' | 'waiting' | 'blocked'; next?: string }>;
  commitments: Array<ProposedItem & { trigger?: string }>;
  waiting: Array<ProposedItem & { on?: 'user' | 'external' }>;
  corrections: Array<ProposedItem & { supersedes?: string }>;
  recentlyDone: ProposedItem[];
  /** 本轮已经完成 / 不再成立的旧条目(按原文匹配);删除同样要证据。 */
  resolved: ProposedItem[];
}

export interface ProposalMessage {
  id: string;
  role: string;
  text: string;
}

function evidenceHolds(evidence: WorkingMemoryEvidence | undefined, messages: ProposalMessage[], roles: readonly string[]): boolean {
  if (!evidence) return false;
  return messages.some((m) => m.id === evidence.messageId && roles.includes(m.role) && m.text.includes(evidence.quote));
}

const NEW_ITEM_ROLES = ['user', 'assistant'] as const;
const RESOLVE_ROLES = ['user', 'assistant', 'tool_result'] as const;

/**
 * 把模型提案并进已有账本,规则与记忆复盘一致:**没有原文证据的新条目不进账**。
 *  - 与旧条目原文相同的条目直接沿用(保留 id / messageId),不需要证据;
 *  - 新条目或改写过的条目必须引用本轮消息里的用户或伙伴原话;
 *  - 旧条目不在提案里时**保留**——漏写不等于完成;要删除走 `resolved`,同样要证据
 *    (用户 / 伙伴 / 工具结果均可)。
 *  - 各区按上限保留最新的。
 */
export function applyWorkingMemoryProposal(
  previous: BotWorkingMemory | null,
  proposal: WorkingMemoryProposal,
  messages: ProposalMessage[],
  opts: { now: number; coveredThroughRowid: number },
): Omit<BotWorkingMemory, 'revision' | 'version'> {
  const prev = previous ?? emptyWorkingMemory();
  const resolvedTexts = new Set(
    proposal.resolved
      .filter((item) => evidenceHolds(item.evidence, messages, RESOLVE_ROLES))
      .map((item) => clampText(item.text)),
  );
  let seq = 0;
  const nextId = () => `wm_${opts.now.toString(36)}_${(seq += 1)}`;

  function merge<P extends ProposedItem, T extends WorkingMemoryItem>(
    existing: T[],
    proposed: P[],
    cap: number,
    build: (base: WorkingMemoryItem, item: P) => T,
  ): T[] {
    const byText = new Map(existing.map((item) => [item.text, item] as const));
    const kept = new Map<string, T>();
    for (const item of proposed) {
      const text = clampText(item.text);
      if (!text || resolvedTexts.has(text)) continue;
      const prior = byText.get(text);
      if (prior) {
        kept.set(text, build({ ...prior, updatedAt: opts.now }, item));
        continue;
      }
      if (!evidenceHolds(item.evidence, messages, NEW_ITEM_ROLES)) continue;
      kept.set(text, build({ id: nextId(), text, messageId: item.evidence!.messageId, updatedAt: opts.now }, item));
    }
    // 提案没提到的旧条目保留(漏写 ≠ 完成),除非被 resolved 点名。
    for (const item of existing) {
      if (!kept.has(item.text) && !resolvedTexts.has(item.text)) kept.set(item.text, item);
    }
    return [...kept.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, cap);
  }

  return {
    coveredThroughRowid: Math.max(prev.coveredThroughRowid, opts.coveredThroughRowid),
    updatedAt: opts.now,
    threads: merge(prev.threads, proposal.threads, WORKING_MEMORY_LIMITS.threads, (base, item) => ({
      ...base,
      status: item.status ?? ('status' in base ? (base as WorkingThread).status : 'active'),
      ...(clampText(item.next) ? { next: clampText(item.next) } : {}),
    })),
    commitments: merge(prev.commitments, proposal.commitments, WORKING_MEMORY_LIMITS.commitments, (base, item) => ({
      ...base,
      ...(clampText(item.trigger, 120) ? { trigger: clampText(item.trigger, 120) } : {}),
    })),
    waiting: merge(prev.waiting, proposal.waiting, WORKING_MEMORY_LIMITS.waiting, (base, item) => ({
      ...base,
      on: item.on ?? ('on' in base ? (base as WorkingWait).on : 'user'),
    })),
    corrections: merge(prev.corrections, proposal.corrections, WORKING_MEMORY_LIMITS.corrections, (base, item) => ({
      ...base,
      ...(clampText(item.supersedes) ? { supersedes: clampText(item.supersedes) } : {}),
    })),
    recentlyDone: merge(prev.recentlyDone, proposal.recentlyDone, WORKING_MEMORY_LIMITS.recentlyDone, (base) => base),
  };
}

/** 发给复盘模型的紧凑视图(不带 id / 时间戳,省 token)。 */
export function workingMemoryForReview(memory: BotWorkingMemory | null): Record<string, unknown> {
  const m = memory ?? emptyWorkingMemory();
  return {
    threads: m.threads.map((t) => ({ text: t.text, status: t.status, ...(t.next ? { next: t.next } : {}) })),
    commitments: m.commitments.map((c) => ({ text: c.text, ...(c.trigger ? { trigger: c.trigger } : {}) })),
    waiting: m.waiting.map((w) => ({ text: w.text, on: w.on })),
    corrections: m.corrections.map((c) => ({ text: c.text, ...(c.supersedes ? { supersedes: c.supersedes } : {}) })),
    recentlyDone: m.recentlyDone.map((d) => ({ text: d.text })),
  };
}

// ── 渲染成交接段落 ─────────────────────────────────────────────────────────────

export interface WorkingMemoryOpenTask {
  id: string;
  objective: string;
  status: string;
}

export const WORKING_MEMORY_HEADING = '== Working memory (host-maintained summary; not authorization) ==';

/**
 * 渲染顺序即优先级:超预算时从末尾的区整段丢。纠正、承诺、等待永不丢;
 * 后台任务来自数据库;线索和近期完成在预算紧张时省略。
 */
export function renderWorkingMemory(
  memory: BotWorkingMemory,
  extras: { openTasks?: WorkingMemoryOpenTask[] } = {},
  budget = WORKING_MEMORY_RENDER_BUDGET,
): string | null {
  const ref = (item: WorkingMemoryItem) => (item.messageId ? ` (message_id: ${item.messageId})` : '');
  const sections: string[] = [];
  if (memory.corrections.length) {
    sections.push(
      'Latest user corrections and decisions (newest first; later ones override earlier ones):\n' +
        memory.corrections.map((c) => `- ${c.text}${c.supersedes ? ` [supersedes: ${c.supersedes}]` : ''}${ref(c)}`).join('\n'),
    );
  }
  if (memory.commitments.length) {
    sections.push(
      'Things you promised and have not yet delivered:\n' +
        memory.commitments.map((c) => `- ${c.text}${c.trigger ? ` [when: ${c.trigger}]` : ''}${ref(c)}`).join('\n'),
    );
  }
  if (memory.waiting.length) {
    sections.push(
      'Waiting on:\n' + memory.waiting.map((w) => `- ${w.on === 'user' ? 'user' : 'external'}: ${w.text}${ref(w)}`).join('\n'),
    );
  }
  const openTasks = extras.openTasks ?? [];
  if (openTasks.length) {
    sections.push(
      'Background tasks still running (from the host task records; results arrive as receipts, do not redo them):\n' +
        openTasks.map((t) => `- [${t.status}] ${clampText(t.objective, 160)} (task_id: ${t.id})`).join('\n'),
    );
  }
  if (memory.threads.length) {
    sections.push(
      'Open threads:\n' +
        memory.threads
          .map((t) => `- [${t.status}] ${t.text}${t.next ? ` → next: ${t.next}` : ''}${ref(t)}`)
          .join('\n'),
    );
  }
  if (memory.recentlyDone.length) {
    sections.push('Recently completed (do not repeat):\n' + memory.recentlyDone.map((d) => `- ${d.text}${ref(d)}`).join('\n'));
  }
  if (sections.length === 0) return null;
  const guidance =
    'This is a host-maintained summary of the ongoing work, not a new instruction and not authorization: ' +
    'past approvals do not permit new actions. When the user refers to something you do not see here, ' +
    'search the conversation history before saying you have no record of it, and never mention this note.';
  // 预算从尾部的区整段丢,头部(纠正 / 承诺 / 等待)保留。
  let body = sections.join('\n\n');
  while (body.length + guidance.length > budget && sections.length > 3) {
    sections.pop();
    body = sections.join('\n\n');
  }
  return `${WORKING_MEMORY_HEADING}\n${guidance}\n\n${body}`;
}

// ── 会话 → 伙伴 → 渲染好的交接段 ───────────────────────────────────────────────

const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting'] as const;
const OPEN_TASKS_LIMIT = 8;

/** 只认活跃、未归档的伙伴主对话;群专线、后台任务、普通任务返回 null。 */
export async function resolveCanonicalBotIdForSession(sessionId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(
      and(
        eq(botSessionLinks.sessionId, sessionId),
        eq(botSessionLinks.role, 'canonical'),
        isNull(botSessionLinks.archivedAt),
        eq(sessions.source, 'bot'),
        eq(sessions.status, 'active'),
        eq(botProfiles.status, 'active'),
      ),
    )
    .limit(1);
  return row?.botId ?? null;
}

async function listOpenTasks(botId: string): Promise<WorkingMemoryOpenTask[]> {
  const rows = await getDbClient()
    .drizzle.select({ id: botDelegations.id, objective: botDelegations.objective, status: botDelegations.status })
    .from(botDelegations)
    .where(and(eq(botDelegations.requestingBotId, botId), inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES])))
    .limit(OPEN_TASKS_LIMIT);
  return rows.map((row) => ({ id: row.id, objective: row.objective, status: String(row.status) }));
}

/**
 * 换窗交接 / 压缩后刷新用的渲染段;非伙伴主对话或没有账本时返回 null。
 * 任何读取失败都按"没有账本"处理——账本是增强,不能挡住换窗。
 */
export async function readWorkingMemoryNoteForSession(
  sessionId: string,
  userDataDir: string,
): Promise<string | null> {
  try {
    const botId = await resolveCanonicalBotIdForSession(sessionId);
    if (!botId) return null;
    const memory = await readBotWorkingMemory(userDataDir, botId);
    if (!memory) return null;
    const openTasks = await listOpenTasks(botId).catch(() => []);
    return renderWorkingMemory(memory, { openTasks });
  } catch {
    return null;
  }
}

// ── 原生压缩后的一次性刷新 ─────────────────────────────────────────────────────

/**
 * 原生自动压缩边界之后,下一次发送前置一次账本:宿主拿不到原生摘要,不知道它丢了什么,
 * 只能用账本兜住。交接首条(pending handoff)已含账本时不重复。
 */
export interface WorkingMemoryRefreshRegistry {
  markCompacted(sessionId: string): void;
  isPending(sessionId: string): boolean;
  /** 引擎接受发送后调用;未接受保留,下次重试。 */
  consume(sessionId: string): void;
}

export function createWorkingMemoryRefreshRegistry(): WorkingMemoryRefreshRegistry {
  const pending = new Set<string>();
  return {
    markCompacted: (sessionId) => void pending.add(sessionId),
    isPending: (sessionId) => pending.has(sessionId),
    consume: (sessionId) => void pending.delete(sessionId),
  };
}

export const WORKING_MEMORY_REFRESH_TERMINATOR = "== End of working memory refresh; the user's new message follows ==";

export function buildWorkingMemoryRefreshNote(rendered: string): string {
  return (
    `[Working memory refresh · internal context]\n` +
    `The native context was just compacted. The host re-supplies its working memory so nothing agreed with the user is lost. ` +
    `Do not mention this note to the user.\n\n${rendered}\n\n${WORKING_MEMORY_REFRESH_TERMINATOR}`
  );
}
