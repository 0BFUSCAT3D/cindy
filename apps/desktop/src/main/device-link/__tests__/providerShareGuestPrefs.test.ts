import fs from 'node:fs';
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

    fs.rmSync(file(), { recursive: true, force: true });
    await setProviderShareCredentialConsent('write-fails', 'global', true);
    expect(isProviderShareCredentialConsentSkipped('write-fails')).toBe(true);
  });
});
