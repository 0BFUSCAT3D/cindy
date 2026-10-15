import { describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current', () => ({ getDbClient: vi.fn() }));

const { appendDefaultRouteNotice, isHookDefaultRouteRow } = await import('../defaultRouteFollow');
import type { SessionRouteRow } from '../../im/shared/channelDefaultRouteSync';

function row(overrides: Partial<SessionRouteRow> = {}): SessionRouteRow {
  return {
    source: 'telegram',
    status: 'active',
    remoteHostId: null,
    orcaRole: null,
    agentKind: 'codex',
    model: 'gpt-6-astra',
    providerId: 'openai',
    effort: 'high',
    imDefaultRoute: null,
    feishuBotAppId: null,
    imBotContextId: null,
    ...overrides,
  };
}

describe('isHookDefaultRouteRow', () => {
  it('owns official Telegram / X tasks, recorded or not', () => {
    expect(isHookDefaultRouteRow(row())).toBe(true);
    expect(isHookDefaultRouteRow(row({ source: 'x' }))).toBe(true);
    // Slack hook 任务没有渠道名列, 只在建任务时写过记录后才归这里。
    expect(isHookDefaultRouteRow(row({ source: null }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ source: null, imDefaultRoute: '{"v":1}' }))).toBe(true);
  });

  it('leaves personal-channel, taken-over desktop, remote and archived tasks alone', () => {
    expect(isHookDefaultRouteRow(row({ imBotContextId: 'bot' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ source: 'feishu', feishuBotAppId: 'cli' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ source: 'desktop' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ remoteHostId: 'ssh-1' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ orcaRole: 'worker' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ status: 'archived' }))).toBe(false);
    expect(isHookDefaultRouteRow(row({ model: null }))).toBe(false);
  });
});

describe('appendDefaultRouteNotice', () => {
  it('appends the notice after the reply, keeping the reply first', () => {
    expect(appendDefaultRouteNotice('答案\n', 'ℹ️ 提示')).toBe('答案\n\nℹ️ 提示');
    expect(appendDefaultRouteNotice('  ', 'ℹ️ 提示')).toBe('ℹ️ 提示');
    expect(appendDefaultRouteNotice('答案', null)).toBe('答案');
  });
});
