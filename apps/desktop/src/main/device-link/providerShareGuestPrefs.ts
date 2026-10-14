/**
 * 供应商分享 · 受邀者这台电脑对每个分享的本机偏好(provider-sharing.md §9 第 7 条)。
 *
 * 目前只有一项：「信任 {分享者}」——用这个分享的任务里读写凭证类文件、执行读取凭证的命令时
 * 不再在本机弹确认卡，与本机任务一致。粒度是一个分享(分享者 × 供应商)，只对这台电脑生效。
 *
 *  - 只存用户显式打开的项(override)；没有记录 = 默认要确认。
 *  - 文件按账号放在 owners/<账号>/provider-share-guest-prefs.json，只含服务端生成的分享 id 与分享
 *    所属区域，不含昵称、对话或凭证。
 *  - 分享被删除或受邀者退出后一起清掉：退出时直接忘掉；分享从已确认区域的权威名单里消失时清掉，
 *    还没加载的区域不动(跨区域分享晚加载时不误删)。
 *  - 没有配置存储位置(测试、未登录)时只留在内存里。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('provider-share:guest-prefs');

type Region = 'cn' | 'global';

interface GuestPrefRecord {
  region: Region;
  /** 凭证类操作不再在本机确认。只在为 true 时写入。 */
  skipCredentialConsent: true;
}

interface StoredPrefs {
  version: 1;
  shares: Record<string, GuestPrefRecord>;
}

const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/;

let resolvePath: (() => string) | null = null;
let cache: { file: string | null; shares: Map<string, GuestPrefRecord> } | null = null;
let writes: Promise<void> = Promise.resolve();

/** 由本机接线在启动时提供文件位置(按当前账号解析)；传 null 回到只在内存里。 */
export function configureProviderShareGuestPrefs(options: { resolvePath: (() => string) | null }): void {
  resolvePath = options.resolvePath;
  cache = null;
}

function currentFile(): string | null {
  try {
    return resolvePath ? resolvePath() : null;
  } catch (error) {
    log.warn('guest prefs path unavailable', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function parse(raw: string): Map<string, GuestPrefRecord> {
  const shares = new Map<string, GuestPrefRecord>();
  const parsed = JSON.parse(raw) as Partial<StoredPrefs> | null;
  if (!parsed || parsed.version !== 1 || !parsed.shares || typeof parsed.shares !== 'object') return shares;
  for (const [shareId, value] of Object.entries(parsed.shares as Record<string, unknown>)) {
    if (!SHARE_ID.test(shareId) || !value || typeof value !== 'object') continue;
    const record = value as Partial<GuestPrefRecord>;
    if ((record.region !== 'cn' && record.region !== 'global') || record.skipCredentialConsent !== true) continue;
    shares.set(shareId, { region: record.region, skipCredentialConsent: true });
  }
  return shares;
}

/** 当前账号的偏好；账号(文件位置)变了就重读。读不到按没有偏好处理。 */
function load(): Map<string, GuestPrefRecord> {
  const file = currentFile();
  if (cache && cache.file === file) return cache.shares;
  let shares = new Map<string, GuestPrefRecord>();
  if (file) {
    try {
      shares = parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('guest prefs unreadable; treating as none', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  cache = { file, shares };
  return shares;
}

function persist(file: string | null, shares: Map<string, GuestPrefRecord>): Promise<void> {
  if (!file) return Promise.resolve();
  const snapshot: StoredPrefs = { version: 1, shares: Object.fromEntries(shares) };
  const write = writes.then(() => writeFile(file, snapshot));
  writes = write.catch((error) => {
    log.warn('guest prefs write failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return write;
}

async function writeFile(file: string, snapshot: StoredPrefs): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** 这个分享的任务里凭证类操作是否不再确认(默认 false)。 */
export function isProviderShareCredentialConsentSkipped(shareId: string): boolean {
  return load().get(shareId)?.skipCredentialConsent === true;
}

/** 打开或关掉「信任 {分享者}」。关掉就是删掉记录(只存 override)。 */
export async function setProviderShareCredentialConsent(shareId: string, region: Region, skip: boolean): Promise<void> {
  if (!SHARE_ID.test(shareId)) throw new Error('Invalid provider share id');
  const file = currentFile();
  const shares = new Map(load());
  if (skip) shares.set(shareId, { region, skipCredentialConsent: true });
  else shares.delete(shareId);
  cache = { file, shares };
  await persist(file, shares);
}

/** 受邀者退出了这个分享：忘掉它的偏好。 */
export function forgetProviderShareGuestPrefs(shareId: string): void {
  const file = currentFile();
  const shares = load();
  if (!shares.has(shareId)) return;
  const next = new Map(shares);
  next.delete(shareId);
  cache = { file, shares: next };
  void persist(file, next);
}

/**
 * 按权威名单清理：只清 `confirmedRegions` 里的区域中已经不在 `present` 的分享，其它区域(还没加载)
 * 的记录原样保留。
 */
export function pruneProviderShareGuestPrefs(present: ReadonlySet<string>, confirmedRegions: readonly Region[]): void {
  if (confirmedRegions.length === 0) return;
  const file = currentFile();
  const shares = load();
  const next = new Map(shares);
  for (const [shareId, record] of shares) {
    if (confirmedRegions.includes(record.region) && !present.has(shareId)) next.delete(shareId);
  }
  if (next.size === shares.size) return;
  cache = { file, shares: next };
  void persist(file, next);
}

/** 等最近一次写入落盘(测试与退出前用)。 */
export function flushProviderShareGuestPrefs(): Promise<void> {
  return writes;
}

/** 仅测试用：回到初始状态。 */
export function resetProviderShareGuestPrefsForTests(): void {
  resolvePath = null;
  cache = null;
  writes = Promise.resolve();
}
