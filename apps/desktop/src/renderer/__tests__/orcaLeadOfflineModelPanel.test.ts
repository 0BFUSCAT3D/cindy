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
  it('按连接不可达与版本不支持分开,不再笼统归因于被控电脑需要更新', () => {
    expect(favoritesSyncFailureI18nKey('unreachable')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnreachable',
    );
    expect(favoritesSyncFailureI18nKey('unsupported')).toBe(
      'newChat.modelSelector.unified.favoritesSyncFailedUnsupported',
    );
  });
});

describe('ChatInput 接线', () => {
  it('协同 Lead 离线回落走同一套切换事务,但远程在线仍 fail-closed', () => {
    const chatInput = read('../components/new-chat/ChatInput.tsx');
    expect(chatInput).toContain('orcaLeadLocalFallbackOpen(');
    expect(chatInput).toContain('sessionRemoteAgentDevicesForOrcaFallback(');
    expect(chatInput).toContain('sessionAgentSwitchSupported({');
  });
});

describe('收藏同步失败词表', () => {
  const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;
  const misleading = /可能需要更新|may need an update|업데이트해야|更新が必要/;

  it('五份 locale 按失败原因区分,且不再暗示被控电脑需要更新', () => {
    for (const locale of locales) {
      const json = JSON.parse(
        read(`../i18n/locales/${locale}/common.json`),
      ) as {
        newChat: {
          modelSelector: {
            unified: Record<string, string>;
          };
        };
      };
      const unified = json.newChat.modelSelector.unified;
      expect(unified.favoritesSyncFailedUnreachable).toEqual(expect.any(String));
      expect(unified.favoritesSyncFailedUnsupported).toEqual(expect.any(String));
      expect(unified.favoritesSyncFailedUnreachable).not.toMatch(misleading);
      expect(unified.favoritesSyncFailedUnsupported).not.toMatch(misleading);
      expect(unified.favoritesSyncFailed ?? '').not.toMatch(misleading);
    }
  });
});
