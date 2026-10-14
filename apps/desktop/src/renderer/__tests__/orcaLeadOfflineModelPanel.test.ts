/**
 * 协同 Lead 远程 Agent 离线时切回本机(SC1/SC2)与收藏同步失败文案(SC4)的接线锁。
 * 行为断言走纯函数;ChatInput / 词表用源码锁,避免把 ChatInput 整棵树拉进 jsdom。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  orcaLeadLocalFallbackOpen,
  sessionAgentSwitchSupported,
  sessionRemoteAgentDevicesForOrcaFallback,
  favoritesSyncFailureI18nKey,
} from '../components/new-chat/sessionAgentSwitchGate';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

describe('orcaLeadLocalFallbackOpen', () => {
  it('只在协同 Lead、Agent 在另一台电脑、且那台目录读取失败时开放切回本机', () => {
    expect(
      orcaLeadLocalFallbackOpen({
        sessionOrcaRole: 'lead',
        agentDeviceId: 'office-pc',
        remoteCatalogStatus: 'error',
      }),
    ).toBe(true);
  });

  it('远程在线、Worker、本机 Lead、角色未加载都不开放', () => {
    const base = {
      sessionOrcaRole: 'lead' as const,
      agentDeviceId: 'office-pc',
      remoteCatalogStatus: 'error' as const,
    };
    expect(orcaLeadLocalFallbackOpen({ ...base, remoteCatalogStatus: 'ready' })).toBe(false);
    expect(orcaLeadLocalFallbackOpen({ ...base, remoteCatalogStatus: 'loading' })).toBe(false);
    expect(orcaLeadLocalFallbackOpen({ ...base, sessionOrcaRole: 'worker' })).toBe(false);
    expect(orcaLeadLocalFallbackOpen({ ...base, sessionOrcaRole: null })).toBe(false);
    expect(orcaLeadLocalFallbackOpen({ ...base, sessionOrcaRole: undefined })).toBe(false);
    expect(orcaLeadLocalFallbackOpen({ ...base, agentDeviceId: null })).toBe(false);
  });
});

describe('sessionAgentSwitchSupported', () => {
  it('非协同会话保持原能力位;协同 Lead 仅离线回落时开放切换事务', () => {
    expect(
      sessionAgentSwitchSupported({
        sessionOrcaRole: null,
        hostSwitchCapable: true,
        orcaLeadLocalFallback: false,
      }),
    ).toBe(true);
    expect(
      sessionAgentSwitchSupported({
        sessionOrcaRole: 'lead',
        hostSwitchCapable: true,
        orcaLeadLocalFallback: false,
      }),
    ).toBe(false);
    expect(
      sessionAgentSwitchSupported({
        sessionOrcaRole: 'lead',
        hostSwitchCapable: true,
        orcaLeadLocalFallback: true,
      }),
    ).toBe(true);
    expect(
      sessionAgentSwitchSupported({
        sessionOrcaRole: undefined,
        hostSwitchCapable: true,
        orcaLeadLocalFallback: false,
      }),
    ).toBe(false);
  });
});

describe('sessionRemoteAgentDevicesForOrcaFallback', () => {
  it('离线回落不列出其它电脑,避免协同任务在远程在线路径外开放跨电脑切换', () => {
    const devices = [
      { deviceId: 'office-pc', name: 'Office' },
      { deviceId: 'studio-mac', name: 'Studio' },
    ];
    expect(sessionRemoteAgentDevicesForOrcaFallback(devices, false)).toEqual(devices);
    expect(sessionRemoteAgentDevicesForOrcaFallback(devices, true)).toEqual([]);
  });
});

describe('favoritesSyncFailureI18nKey', () => {
  it('连接类错误码用 Unreachable 文案,其余错误保留原文案', () => {
    expect(favoritesSyncFailureI18nKey('DEVICE_LINK_NOT_CONNECTED')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnreachable',
    );
    expect(favoritesSyncFailureI18nKey('DEVICE_LINK_DEVICE_OFFLINE')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnreachable',
    );
    expect(favoritesSyncFailureI18nKey('DEVICE_LINK_TIMEOUT')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnreachable',
    );
    expect(favoritesSyncFailureI18nKey('DEVICE_LINK_BUSY')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnreachable',
    );
    expect(favoritesSyncFailureI18nKey('DEVICE_LINK_CHANNEL_NOT_ALLOWED')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailed',
    );
    expect(favoritesSyncFailureI18nKey(null)).toBe('newChat.modelSelector.unified.favoritesSyncFailed');
    expect(favoritesSyncFailureI18nKey(undefined)).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailed',
    );
  });
});

describe('ChatInput 接线', () => {
  it('协同 Lead 离线回落走同一套切换事务,但远程在线仍 fail-closed', () => {
    const chatInput = read('../components/new-chat/ChatInput.tsx');
    expect(chatInput).toContain('orcaLeadLocalFallbackOpen(');
    expect(chatInput).toContain('sessionRemoteAgentDevicesForOrcaFallback(');
    expect(chatInput).toContain('sessionAgentSwitchSupportedOf({');
  });

  it('fallback 打开时把统一面板引擎集合锁到当前引擎', () => {
    const chatInput = read('../components/new-chat/ChatInput.tsx');
    expect(chatInput).toContain('(!sessionEngineFilter || orcaLeadLocalFallback)');
  });
});

describe('收藏同步失败词表', () => {
  const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

  it('五份 locale:连不上用新 Unreachable 文案,其它错误保留原 favoritesSyncFailed,无 Unsupported key', () => {
    const expectedUnreachable: Record<(typeof locales)[number], string> = {
      'zh-CN': '收藏暂时没有同步：那台电脑当前连不上。恢复连接后重新打开即可。',
      'zh-TW': '收藏暫時沒有同步：那台電腦目前連不上。恢復連線後重新開啟即可。',
      en: 'Favorites are not synced yet: that computer is unreachable. Reopen the picker after the connection returns.',
      ja: 'お気に入りはまだ同期されていません。そのパソコンに現在接続できません。接続が戻ってから開き直してください。',
      ko: '즐겨찾기가 아직 동기화되지 않았습니다. 그 컴퓨터에 현재 연결할 수 없습니다. 연결이 복구된 후 다시 여세요.',
    };
    const expectedOriginal: Record<(typeof locales)[number], string> = {
      'zh-CN': '收藏未能同步。请重新打开重试；被控电脑可能需要更新。',
      'zh-TW': '收藏未能同步。請重新開啟重試；被控電腦可能需要更新。',
      en: 'Favorites could not sync. Reopen the picker to retry; the remote computer may need an update.',
      ja: 'お気に入りを同期できません。選択画面を開き直してください。接続先の更新が必要な場合があります。',
      ko: '즐겨찾기를 동기화할 수 없습니다. 선택 화면을 다시 여세요. 원격 컴퓨터를 업데이트해야 할 수 있습니다.',
    };
    for (const locale of locales) {
      const json = JSON.parse(
        read(`../i18n/locales/${locale}/common.json`),
      ) as {
        newChat: {
          modelSelector: {
            unified: Record<string, string | undefined>;
          };
        };
      };
      const unified = json.newChat.modelSelector.unified;
      expect(unified.favoritesSyncFailedUnreachable).toBe(expectedUnreachable[locale]);
      expect(unified.favoritesSyncFailed).toBe(expectedOriginal[locale]);
      expect(unified.favoritesSyncFailedUnsupported).toBeUndefined();
    }
  });
});
