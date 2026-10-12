// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';

import type { ProviderGroupMemberStatus } from '../../../../shared/providerGroup';
import { GroupMemberVersion } from '../GroupMemberVersion';

const catalogs = { en, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW };
const status: ProviderGroupMemberStatus = {
  key: 'local', kind: 'local', label: 'Computer', state: 'available', running: 0, limit: 4, weight: 1, paused: false,
  appVersion: '0.1.103', guestSupport: 'needs-update',
};
afterEach(cleanup);

describe('group member version translations', () => {
  it.each([
    ['en', 'Update needed to receive shared tasks'],
    ['ja', '共有されたタスクを受け取るには更新が必要'],
    ['ko', '공유받은 작업을 실행하려면 업데이트 필요'],
    ['zh-CN', '需要更新才能接收分享任务'],
    ['zh-TW', '需要更新才能接收分享任務'],
  ] as const)('renders actual %s text and keeps missing versions unknown', async (lang, warning) => {
    const i18n = createInstance();
    await i18n.init({ lng: lang, fallbackLng: false, resources: { [lang]: { translation: catalogs[lang] } } });
    const { rerender } = render(<I18nextProvider i18n={i18n}><GroupMemberVersion status={status} /></I18nextProvider>);
    expect(screen.getByText('Cindy 0.1.103')).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(document.body.textContent).not.toContain('???');
    rerender(<I18nextProvider i18n={i18n}><GroupMemberVersion status={{ ...status, appVersion: undefined, guestSupport: undefined }} /></I18nextProvider>);
    expect(screen.getByText(catalogs[lang].providerGroup.member.version.unknown)).toBeTruthy();
    expect(screen.getByText(catalogs[lang].providerGroup.member.version.supportUnknown)).toBeTruthy();
    expect(screen.queryByText(warning)).toBeNull();
  });
});
