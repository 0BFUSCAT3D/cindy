/**
 * main/im/shared/inboundFileStaging.ts
 * ---------------------------------------------------------------------------
 * 个人 IM 渠道入站**非媒体文件**(PDF / docx / zip …)的受控存放。媒体(图片/
 * 音视频)走 cindy-media 总仓, 不经这里。
 *
 * 目录(按账号隔离, 与微信 `mediaStaging.ts` 同一棵树):
 *   im-attachments/<channel>/staging/<uuid>-<name>            ← transport 下载时(任务未知)
 *   im-attachments/<channel>/sessions/<sessionId>/<uuid>-<name> ← 路由到任务后移入
 *
 * 生命周期:
 *   - transport 经 `IMHost.files.stage` 写入 staging(下载时还不知道归哪个任务);
 *   - turnRunner 在任务确定后、把路径交给模型/落库之前调用 `adoptStagedInboundFiles`
 *     原地改写 absPath 为任务目录下的路径;
 *   - 任务删除时 `removeImSessionAttachmentDirs` 清掉所有渠道下该任务的目录;
 *   - 没被任何任务领走的 staging 文件(消息被丢弃/拒绝)在下次暂存时按龄清理。
 *
 * 不写 `cc-agent/*-media`: 那是冻结的历史兼容层(媒体规则), 只读。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { IMAttachment, IMHostFileStaging } from '@cindy/im';

import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

const log = createLogger('im/inbound-file-staging');

const ROOT_DIR = 'im-attachments';
const STAGING_DIR = 'staging';
const SESSIONS_DIR = 'sessions';
/** staging 里超过这个年龄的文件视为无人认领(消息已被丢弃), 下次暂存时清掉。 */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** 同一 staging 目录两次清扫的最小间隔。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

type Integration = Parameters<IMHostFileStaging['stage']>[0]['integration'];

const lastSweepAt = new Map<string, number>();

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 平台文件名不可信: 去路径分隔与保留字符、截断, 保留扩展名。 */
export function sanitizeInboundFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!cleaned) return 'attachment';
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  return `${cleaned.slice(0, 120 - ext.length)}${ext}`;
}

function stagingDir(integration: Integration): string {
  return path.resolve(ownerScopedImUserDataPath(ROOT_DIR, integration, STAGING_DIR));
}

async function sweepStaleStaging(dir: string, now: number): Promise<void> {
  const last = lastSweepAt.get(dir) ?? 0;
  if (now - last < SWEEP_INTERVAL_MS) return;
  lastSweepAt.set(dir, now);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const candidate = path.join(dir, name);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isFile() && now - stat.mtimeMs > STAGING_MAX_AGE_MS) {
          await fs.rm(candidate, { force: true });
        }
      } catch {
        /* 并发移走/删掉: 忽略 */
      }
    }),
  );
}

export async function stageInboundFile(params: {
  integration: Integration;
  buffer: Uint8Array;
  fileName: string;
}): Promise<{ absPath: string; discard: () => Promise<void> }> {
  const dir = stagingDir(params.integration);
  await fs.mkdir(dir, { recursive: true });
  void sweepStaleStaging(dir, Date.now()).catch(() => undefined);
  const absPath = path.join(dir, `${randomUUID()}-${sanitizeInboundFileName(params.fileName)}`);
  if (!isWithin(dir, absPath)) throw new Error('IM_INBOUND_FILE_PATH_OUT_OF_BOUNDS');
  await fs.writeFile(absPath, params.buffer, { flag: 'wx' });
  return {
    absPath,
    discard: async () => {
      await fs.rm(absPath, { force: true });
    },
  };
}

export const inboundFileStaging: IMHostFileStaging = { stage: stageInboundFile };

/**
 * 把仍在 staging 里的附件移入该任务的附件目录, 原地改写 absPath。幂等: 不在
 * staging 的附件(媒体总仓、历史目录、已移入的)原样不动。移动失败保留暂存路径
 * (文件仍可读, 只是不随任务清理), 不阻断本轮。
 */
export async function adoptStagedInboundFiles(
  sessionId: string,
  attachments: readonly IMAttachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  const root = path.resolve(ownerScopedImUserDataPath(ROOT_DIR));
  for (const attachment of attachments) {
    const source = path.resolve(attachment.absPath);
    if (!isWithin(root, source)) continue;
    const [integration, bucket, ...rest] = path.relative(root, source).split(path.sep);
    if (bucket !== STAGING_DIR || rest.length !== 1 || !integration) continue;
    const sessionsRoot = path.resolve(root, integration, SESSIONS_DIR);
    const targetDir = path.resolve(sessionsRoot, sessionId);
    if (!isWithin(sessionsRoot, targetDir)) continue;
    const target = path.join(targetDir, rest[0]);
    try {
      await fs.mkdir(targetDir, { recursive: true });
      await fs.rename(source, target);
      attachment.absPath = target;
    } catch (err) {
      log.warn('adopt staged IM file failed (kept in staging)', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 任务删除: 清掉所有渠道下该任务的附件目录(含微信)。 */
export async function removeImSessionAttachmentDirs(sessionId: string): Promise<void> {
  const root = path.resolve(ownerScopedImUserDataPath(ROOT_DIR));
  let integrations: string[];
  try {
    integrations = await fs.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    integrations.map(async (integration) => {
      const sessionsRoot = path.resolve(root, integration, SESSIONS_DIR);
      const target = path.resolve(sessionsRoot, sessionId);
      if (!isWithin(sessionsRoot, target)) return;
      await fs.rm(target, { recursive: true, force: true });
    }),
  );
}

/** 测试用: 重置清扫节流。 */
export function resetInboundFileStagingForTests(): void {
  lastSweepAt.clear();
}
