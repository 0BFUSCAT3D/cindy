import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../shared/ipc-errors.js';
import { setProviderShareCredentialConsentFromIpc } from '../providerShareGuestPrefsIpc.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

import {
  configureProviderShareGuestPrefs,
  flushProviderShareGuestPrefs,
  forgetProviderShareGuestPrefs,
  invalidateProviderShareGuestPrefsCache,
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
  it.each(['mkdir', 'writeFile', 'rename'] as const)('does not publish or retry a failed trust update when %s fails', async (operation) => {
    await setProviderShareCredentialConsent('kept', 'global', true);
    vi.spyOn(fsp, operation).mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(setProviderShareCredentialConsent('failed', 'global', true)).rejects.toThrow('disk unavailable');
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    await setProviderShareCredentialConsent('saved', 'cn', true);
    expect(stored().shares).toEqual({
      kept: { region: 'global', skipCredentialConsent: true },
      saved: { region: 'cn', skipCredentialConsent: true },
    });
    restart();
    expect(isProviderShareCredentialConsentSkipped('failed')).toBe(false);
  });

  it('keeps the saved trust state when disabling it cannot be persisted', async () => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(setProviderShareCredentialConsent('share-1', 'global', false)).rejects.toThrow('disk unavailable');
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('publishes trust only after the atomic write succeeds', async () => {
    const rename = fsp.rename;
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (source, target) => {
      await pendingWrite;
      await rename(source, target);
    });
    const saving = setProviderShareCredentialConsent('share-1', 'global', true);
    try {
      await vi.waitFor(() => expect(renameSpy).toHaveBeenCalled());
      expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
    } finally {
      finishWrite();
      await saving;
    }
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('preserves independent concurrent updates and later removals', async () => {
    await Promise.all([
      setProviderShareCredentialConsent('share-1', 'global', true),
      setProviderShareCredentialConsent('share-2', 'cn', true),
    ]);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('share-2')).toBe(true);

    const saving = setProviderShareCredentialConsent('share-3', 'global', true);
    const forgetting = forgetProviderShareGuestPrefs('share-3');
    const pruning = pruneProviderShareGuestPrefs(new Set(['share-1']), ['global']);
    await Promise.all([saving, forgetting, pruning]);
    await flushProviderShareGuestPrefs();
    expect(stored().shares).toEqual({
      'share-1': { region: 'global', skipCredentialConsent: true },
      'share-2': { region: 'cn', skipCredentialConsent: true },
    });
  });

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
    await pruneProviderShareGuestPrefs(new Set(['kept']), ['global']);
    expect(isProviderShareCredentialConsentSkipped('same-region')).toBe(false);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    // 没有任何已确认区域(刚启动 / 读失败)：什么都不清。
    await pruneProviderShareGuestPrefs(new Set(), []);
    expect(isProviderShareCredentialConsentSkipped('cross-region')).toBe(true);
    expect(isProviderShareCredentialConsentSkipped('kept')).toBe(true);

    await forgetProviderShareGuestPrefs('cross-region');
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

  it('reloads the shared file after another Desktop instance changes it', async () => {
    await setProviderShareCredentialConsent('share-1', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    // 模拟另一持有者完成原子替换；同一账号的文件路径保持不变。
    fs.writeFileSync(file(), JSON.stringify({ version: 1, shares: {} }));
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    invalidateProviderShareGuestPrefsCache();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });
});

describe('provider share guest prefs IPC boundary', () => {
  it('saves and revokes trust through the IPC write path', async () => {
    await setProviderShareCredentialConsentFromIpc('share-1', 'global', true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);

    await setProviderShareCredentialConsentFromIpc('share-1', 'global', false);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });

  it.each(['mkdir', 'writeFile', 'rename'] as const)('hides filesystem paths when %s fails', async (operation) => {
    const leakedPath = path.join(root, 'owners', owner, 'provider-share-guest-prefs.json.123.tmp');
    const original = Object.assign(new Error(`EACCES: permission denied, ${operation} '${leakedPath}'`), { code: 'EACCES' });
    vi.spyOn(fsp, operation).mockRejectedValueOnce(original);

    const failure = await setProviderShareCredentialConsentFromIpc('share-1', 'global', true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] Failed to save provider share credential consent',
    });
    expect(String(failure)).not.toContain(leakedPath);
    expect(String(failure)).not.toContain('EACCES');
    expect(failure).not.toHaveProperty('cause');
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);

    // IPC 失败不能毒化串行写队列；用户下一次保存仍可成功。
    await setProviderShareCredentialConsentFromIpc('share-1', 'global', true);
    restart();
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(true);
  });

  it('preserves an existing IPC error', async () => {
    const original = createIpcError('PRECONDITION_FAILED', 'Provider sharing is not ready');
    vi.spyOn(fsp, 'mkdir').mockRejectedValueOnce(original);

    await expect(setProviderShareCredentialConsentFromIpc('share-1', 'global', true)).rejects.toBe(original);
    expect(isProviderShareCredentialConsentSkipped('share-1')).toBe(false);
  });
});
