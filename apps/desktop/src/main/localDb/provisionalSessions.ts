/**
 * 未发送任务（provisional task）：用户在新建任务页开始输入时，任务先建出来并出现在本机
 * 任务列表里（可以提前启动 Agent），清空输入就真正删掉；第一次发送时转为普通任务。
 *
 * 只在本机可见：未发送期间不推给手机 / 其它电脑，延后的创建副作用（项目 git 初始化、
 * 最近项目、插件「已创建」事件、device-link 创建通知）在转正时补做。
 *
 * 登记表在内存里同步可查，并写一份到 userData 下的小文件：进程崩溃或退出时没来得及删的
 * 未发送任务，下次打开后在账号库就绪时清掉（输入框内容不跨重启保留，任务留着没有意义）。
 * 不加数据库列，旧版本打开同一个库只会把残留看成一个普通的未发送任务。
 */

import fs from 'node:fs';
import path from 'node:path';

import { and, count, eq, isNull } from 'drizzle-orm';

import { createLogger } from '../logger.js';
import { getCurrentDbClientSnapshot, getDbClient } from './client/current.js';
import { messages, sessions } from './schema.js';

const log = createLogger('provisional-sessions');

const FILE_NAME = 'provisional-sessions.json';
/** 其它账号库里的残留：本账号库查不到时保留一段时间，等那个账号下次登录再清。 */
const FOREIGN_ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;

interface Entry {
  id: string;
  createdAt: number;
}

let resolveFileDir: (() => string) | null = null;
const live = new Map<string, Entry>();
/** 上次运行留下、尚未清理的登记（按账号库逐个清理）。 */
let leftovers: Entry[] | null = null;
const sweptOwners = new WeakSet<object>();

/** Host 启动时注入 userData 目录(用到时才解析)；未注入时只用内存登记。 */
export function configureProvisionalSessions(userDataDir: string | (() => string)): void {
  resolveFileDir = typeof userDataDir === 'string' ? () => userDataDir : userDataDir;
}

function filePath(): string | null {
  try {
    return resolveFileDir ? path.join(resolveFileDir(), FILE_NAME) : null;
  } catch {
    return null;
  }
}

function loadLeftovers(): Entry[] {
  if (leftovers) return leftovers;
  leftovers = [];
  const file = filePath();
  if (!file) return leftovers;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: unknown };
    if (Array.isArray(parsed.entries)) {
      for (const item of parsed.entries) {
        const entry = item as Partial<Entry>;
        if (typeof entry.id === 'string' && entry.id && typeof entry.createdAt === 'number') {
          leftovers.push({ id: entry.id, createdAt: entry.createdAt });
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('provisional session file unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return leftovers;
}

function persist(): void {
  const file = filePath();
  if (!file) return;
  const entries = [...loadLeftovers(), ...live.values()];
  try {
    if (entries.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('provisional session file write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function markProvisionalSession(sessionId: string, now = Date.now()): void {
  loadLeftovers();
  live.set(sessionId, { id: sessionId, createdAt: now });
  persist();
}

export function isProvisionalSession(sessionId: string): boolean {
  return live.has(sessionId);
}

/** Forget the provisional mark (the task was sent, or was deleted). True when it was provisional. */
export function forgetProvisionalSession(sessionId: string): boolean {
  if (!live.delete(sessionId)) return false;
  persist();
  return true;
}

/**
 * Hard-delete a provisional task row, but only while it is still unsent and has no messages.
 * Returns the deleted row's directory facts so the caller can tidy the managed dialogue folder.
 */
export async function deleteUnsentSessionRow(
  sessionId: string,
): Promise<{ workspaceKind: string | null; workingDir: string | null } | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      workspaceKind: sessions.workspaceKind,
      workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.userSendAt != null) return null;
  const [messageCount] = await db
    .select({ n: count() })
    .from(messages)
    .where(eq(messages.sessionId, sessionId));
  if ((messageCount?.n ?? 0) > 0) return null;
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), isNull(sessions.userSendAt)));
  return { workspaceKind: row.workspaceKind ?? null, workingDir: row.workingDir ?? null };
}

/** Remove the managed dialogue folder created for this task when nothing was written into it. */
export function removeEmptyDialogueDir(sessionId: string, workingDir: string | null): void {
  if (!workingDir || path.basename(workingDir) !== sessionId) return;
  try {
    fs.rmdirSync(workingDir);
  } catch {
    // Not empty or already gone: leave it, like any other dialogue folder.
  }
}

/**
 * Account database is ready: delete the unsent tasks a previous run left behind in it.
 * Runs once per database owner; entries from other accounts wait for that account.
 */
export async function sweepLeftoverProvisionalSessions(now = Date.now()): Promise<void> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner || sweptOwners.has(owner)) return;
  sweptOwners.add(owner);
  const pending = loadLeftovers();
  if (pending.length === 0) return;
  const db = getDbClient().drizzle;
  const keep: Entry[] = [];
  for (const entry of pending) {
    try {
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, entry.id))
        .limit(1);
      if (!row) {
        if (now - entry.createdAt < FOREIGN_ENTRY_TTL_MS) keep.push(entry);
        continue;
      }
      const deleted = await deleteUnsentSessionRow(entry.id);
      if (deleted?.workspaceKind === 'dialogue') removeEmptyDialogueDir(entry.id, deleted.workingDir);
      log.info('provisional session leftover swept', { sessionId: entry.id, deleted: !!deleted });
    } catch (error) {
      keep.push(entry);
      log.warn('provisional session leftover sweep failed', {
        sessionId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  leftovers = keep;
  persist();
}

/** Test-only reset. */
export function resetProvisionalSessionsForTest(): void {
  resolveFileDir = null;
  live.clear();
  leftovers = null;
}
