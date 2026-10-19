import { describe, expect, it } from 'vitest';

import { selectFeishuTransport } from '../feishuTransportRouting';

const personal = { id: 'personal' };
const companion = { id: 'companion' };
const lane = { id: 'lane' };

interface Transport { id: string }

function pick(input: Partial<Parameters<typeof selectFeishuTransport<Transport>>[0]>) {
  return selectFeishuTransport<Transport>({
    turnScopeIm: null,
    companionBotId: null,
    companionIm: null,
    personalIm: personal,
    ...input,
  }).id;
}

describe('cindy_feishu_bot transport routing', () => {
  it('uses the connection that triggered this Feishu turn', () => {
    expect(pick({ turnScopeIm: lane, companionBotId: 'bot', companionIm: companion })).toBe('lane');
  });

  it('keeps a companion session on its own connection without a turn scope', () => {
    // 后台任务回执 / 心跳 / 桌面输入触发的轮次没有逐轮作用域; 不能回落到设置页那份。
    expect(pick({ companionBotId: 'bot', companionIm: companion })).toBe('companion');
  });

  it('falls back to the personal bot for non-companion sessions', () => {
    expect(pick({})).toBe('personal');
    expect(pick({ companionBotId: 'bot', companionIm: null })).toBe('personal');
  });
});
