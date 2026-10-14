import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

import {
  configureProviderShareGuestPrefs,
  flushProviderShareGuestPrefs,
  forgetProviderShareGuestPrefs,
  isProviderShareCredentialConsentSkipped,
  pruneProviderShareGuestPrefs,
  resetProviderShareGuestPrefsForTests,
  setProviderShareCredentialConsent,
} from '../providerShareGuestPrefs';

let root: string;
let owner: string;
const file = () => path.join(root, 'owners', owner, 'provider-share-guest-prefs.json');
const stored = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as { version: number; shares: Record<string, unknown> };
/** 模拟重启：丢掉内存里的缓存，重新从文件读。 */
const restart = () => {
  resetProviderShareGuestPrefsForTests();
  configureProviderShareGuestPrefs({ resolvePath: file });
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-prefs-'));
  owner = 'account-a';
  configureProviderShareGuestPrefs({ resolvePath: file });
});

afterEach(async () => {
  await flushProviderShareGuestPrefs();
  vi.restoreAllMocks();
  resetProviderShareGuestPrefsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provider share guest prefs', () => {
  it('defaults to confirming, stores only the override per account, and survives a restart', async () => {
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);

    await setProviderShareCredentialConsent('share-1', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    expect(stored()).toEqual({ version: 1, shares: { 'share-1': { region: 'global', skipCredentialConsent: true } } });

    // 另一个账号看不到这份偏好；切回来仍在。
    owner = 'account-b';
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    owner = 'account-a';
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    // 关掉就是删掉记录(只存 override)。
    await setProviderShareCredentialConsent('share-1', 'global', false);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    expect(stored()).toEqual({ version: 1, shares: {} });
  });

  it('forgets a share on leave and prunes only shares missing from a confirmed region', async () => {
    await setProviderShareCredentialConsent('same-region', 'global', true);
    await setProviderShareCredentialConsent('cross-region', 'cn', true);
    await setProviderShareCredentialConsent('kept', 'global', true);

    // 本区域名单权威、对方区域还没加载：只清本区域里消失的那条。
    pruneProviderShareGuestPrefs(new Set(['kept']), ['global']);
    expect(isProviderShareCredentialConsentSkipped('same-region')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    // 没有任何已确认区域(刚启动 / 读失败)：什么都不清。
    pruneProviderShareGuestPrefs(new Set(), []);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    forgetProviderShareGuestPrefs('cross-region');
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(false);

    await flushProviderShareGuestPrefs();
    expect(stored().shares).toEqual({ kept: { region: 'global', skipCredentialConsent: true } });
    restart();
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('same-region')).toBe(false);
  });

  it('ignores foreign or unreadable records and keeps working in memory without a file', async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({
      version: 1,
      shares: {
        ok: { region: 'cn', skipCredentialConsent: true },
        'bad region': { region: 'mars', skipCredentialConsent: true },
        off: { region: 'cn', skipCredentialConsent: false },
      },
    }));
    expect(isProviderShareCredentialConsentSkipped('ok')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('bad region')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('off')).toBe(false);

    fs.writeFileSync(file(), '{not json');
    restart();
    expect(isProviderShareCredentialConsentSkipped('ok')).toBe(false);

    configureProviderShareGuestPrefs({ resolvePath: null });
    await setProviderShareCredentialConsent('memory-only', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('memory-only')).toBe(true);
    await expect(setProviderShareCredentialConsent('not a share id', 'global', true)).rejects.toThrow();
  });

  it('does not enable trust in memory when the durable write fails', async () => {
    fs.mkdirSync(file(), { recursive: true });

    await expect(setProviderShareCredentialConsent('write-fails', 'global', true)).rejects.toThrow();
    expect(isProviderShareCredentialConsentSkipped('write-fails')).toBe(false);

    fs.rmdirSync(file());
    await setProviderShareCredentialConsent('write-fails', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('write-fails')).toBe(true);
  });

  it('serializes concurrent settings without losing another share or retaining a failed enable', async () => {
    await Promise.all([
      setProviderShareCredentialConsent('first', 'global', true),
      setProviderShareCredentialConsent('second', 'cn', true),
    ]);
    expect(Object.keys(stored().shares).sort()).toEqual(['first', 'second']);

    // 真正的 rename 失败，随后排队的写入仍应成功，不能把失败的启用一起保存。
    const rename = fsp.rename;
    const blocker = path.join(root, 'rename-blocker');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'not a preferences file');
    vi.spyOn(fsp, 'rename').mockImplementationOnce((source) => rename(source, blocker));
    const [failed, saved] = await Promise.allSettled([
      setProviderShareCredentialConsent('failed', 'global', true),
      setProviderShareCredentialConsent('third', 'global', true),
    ]);
    expect(failed.status).toBe('rejected');
    expect(saved.status).toBe('fulfilled');
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(Object.keys(stored().shares).sort()).toEqual(['first', 'second', 'third']);
    restart();
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('third')).toBe(true);
  });

  it.each(['leave', 'prune', 'prune-other'] as const)('does not revive removed trust when %s runs during an in-flight save', async (cleanup) => {
    await setProviderShareCredentialConsent('already-trusted', 'global', true);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const rename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return rename(...args);
    });
    const save = setProviderShareCredentialConsent('pending', 'global', true);
    try {
      await started;
      expect(isProviderShareCredentialConsentSkipped('pending')).toBe(false);
      if (cleanup === 'leave') {
        forgetProviderShareGuestPrefs('pending');
        forgetProviderShareGuestPrefs('already-trusted');
      } else {
        pruneProviderShareGuestPrefs(new Set(cleanup === 'prune-other' ? ['pending'] : []), ['global']);
      }
      expect(isProviderShareCredentialConsentSkipped('already-trusted')).toBe(false);
      expect(isProviderShareCredentialConsentSkipped('pending')).toBe(false);
    } finally {
      release();
      await save;
      await flushProviderShareGuestPrefs();
    }
    expect(stored().shares).toEqual(cleanup === 'prune-other'
      ? { pending: { region: 'global', skipCredentialConsent: true } }
      : {});
    restart();
    expect(isProviderShareCredentialConsentSkipped('pending')).toBe(cleanup === 'prune-other');
    expect(isProviderShareCredentialConsentSkipped('already-trusted')).toBe(false);
  });

  it('keeps concurrent account writes isolated even when switching back before they finish', async () => {
    const accountA = setProviderShareCredentialConsent('only-a', 'global', true);
    owner = 'account-b';
    const accountB = setProviderShareCredentialConsent('only-b', 'global', true);
    owner = 'account-a';
    const accountAAgain = setProviderShareCredentialConsent('also-a', 'cn', true);
    await Promise.all([accountA, accountB, accountAAgain]);
    expect(Object.keys(stored().shares).sort()).toEqual(['also-a', 'only-a']);
    expect(isProviderShareCredentialConsentSkipped('only-a')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('also-a')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('only-b')).toBe(false);
    owner = 'account-b';
    expect(Object.keys(stored().shares)).toEqual(['only-b']);
    expect(isProviderShareCredentialConsentSkipped('only-b')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('only-a')).toBe(false);
  });

  it('retains the previous setting when disabling trust fails to save', async () => {
    await setProviderShareCredentialConsent('trusted', 'global', true);
    const rename = fsp.rename;
    const blocker = path.join(root, 'disable-blocker');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'not a preferences file');
    vi.spyOn(fsp, 'rename').mockImplementationOnce((source) => rename(source, blocker));
    await expect(setProviderShareCredentialConsent('trusted', 'global', false)).rejects.toThrow();
    expect(isProviderShareCredentialConsentSkipped('trusted')).toBe(true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('trusted')).toBe(true);
  });
});
