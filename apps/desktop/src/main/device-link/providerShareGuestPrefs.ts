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

/** 未落盘的设置不参与授权；退出或权威名单清理可以取消它。 */
interface PendingSetting {
  shareId: string;
  region: Region;
  cancelled: boolean;
}

/** 同一账号的读、写共用一份已提交状态，在途写入期间切换账号也不另建旧快照。 */
interface PrefsState {
  file: string | null;
  shares: Map<string, GuestPrefRecord>;
  pending: Set<PendingSetting>;
  writeCount: number;
}

let resolvePath: (() => string) | null = null;
let cache: PrefsState | null = null;
const writing = new Map<string | null, PrefsState>();
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
function load(): PrefsState {
  const file = currentFile();
  if (cache && cache.file === file) return cache;
  const pending = writing.get(file);
  if (pending) return (cache = pending);
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
  cache = { file, shares, pending: new Set(), writeCount: 0 };
  return cache;
}

/** 整个读取、修改、落盘、发布串行执行，后一个设置只基于已成功保存的状态。 */
function enqueueWrite(state: PrefsState, action: () => Promise<void>): Promise<void> {
  state.writeCount += 1;
  writing.set(state.file, state);
  const write = writes.then(action).finally(() => {
    state.writeCount -= 1;
    if (state.writeCount === 0 && writing.get(state.file) === state) writing.delete(state.file);
  });
  writes = write.catch((error) => {
    log.warn('guest prefs write failed', { error: error instanceof Error ? error.message : String(error) });
  });
  return write;
}

function persist(state: PrefsState, shares = state.shares): Promise<void> {
  if (!state.file) return Promise.resolve();
  return writeFile(state.file, { version: 1, shares: Object.fromEntries(shares) });
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
  return load().shares.get(shareId)?.skipCredentialConsent === true;
}

/** 打开或关掉「信任 {分享者}」。关掉就是删掉记录(只存 override)。 */
export async function setProviderShareCredentialConsent(shareId: string, region: Region, skip: boolean): Promise<void> {
  if (!SHARE_ID.test(shareId)) throw new Error('Invalid provider share id');
  const state = load();
  const setting: PendingSetting = { shareId, region, cancelled: false };
  state.pending.add(setting);
  const apply = (shares: Map<string, GuestPrefRecord>) => {
    if (skip) shares.set(shareId, { region, skipCredentialConsent: true });
    else shares.delete(shareId);
  };
  try {
    await enqueueWrite(state, async () => {
      if (setting.cancelled) return;
      const next = new Map(state.shares);
      apply(next);
      await persist(state, next);
      // 清理在等待磁盘时立即撤权；只发布本次设置，不能用旧快照复活其它已清理的分享。
      if (!setting.cancelled) apply(state.shares);
    });
  } finally {
    state.pending.delete(setting);
  }
}

/** 受邀者退出了这个分享：忘掉它的偏好。 */
export function forgetProviderShareGuestPrefs(shareId: string): void {
  removePrefs((id) => id === shareId);
}

/**
 * 按权威名单清理：只清 `confirmedRegions` 里的区域中已经不在 `present` 的分享，其它区域(还没加载)
 * 的记录原样保留。
 */
export function pruneProviderShareGuestPrefs(present: ReadonlySet<string>, confirmedRegions: readonly Region[]): void {
  if (confirmedRegions.length === 0) return;
  removePrefs((shareId, region) => confirmedRegions.includes(region) && !present.has(shareId));
}

/** 撤权立即生效，并排队保存最新已提交状态；失败也不恢复信任，错误由写队列记录。 */
function removePrefs(matches: (shareId: string, region: Region) => boolean): void {
  const state = load();
  let changed = false;
  for (const setting of state.pending) {
    if (!setting.cancelled && matches(setting.shareId, setting.region)) {
      setting.cancelled = true;
      changed = true;
    }
  }
  for (const [shareId, record] of state.shares) {
    if (matches(shareId, record.region)) {
      state.shares.delete(shareId);
      changed = true;
    }
  }
  if (changed) void enqueueWrite(state, () => persist(state)).catch(() => undefined);
}

/** 等最近一次写入落盘(测试与退出前用)。 */
export function flushProviderShareGuestPrefs(): Promise<void> {
  return writes;
}

/** 仅测试用：回到初始状态。 */
export function resetProviderShareGuestPrefsForTests(): void {
  resolvePath = null;
  cache = null;
  writing.clear();
  writes = Promise.resolve();
}
