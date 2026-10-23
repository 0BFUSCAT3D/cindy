import { describe, expect, it } from 'vitest';

import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { colorRegistry } from '../color-registry';
import '../colors';

/**
 * 登录页文字并入墨水阶梯(2026-10-23 用户裁决,DESIGN §16.1)。
 *
 * `login-*` 仍是独立 token 族(只跟随 light / dark,不被扩展主题覆盖),但文字类
 * token 的值与 CINDY 皮肤主界面的墨水档逐字相同。规则只写一处:改主界面墨水
 * 档时登录页必须一起改,反之亦然,不允许两边再各自取一套灰。
 */
const LOGIN_TEXT_TIERS: ReadonlyArray<readonly [loginId: string, inkTierId: string]> = [
  ['login-title-text', 'text-primary'],
  ['login-control-text', 'text-primary'],
  ['login-callback-title', 'text-primary'],
  ['login-secondary-text', 'text-secondary'],
  ['login-callback-body', 'text-secondary'],
  ['login-control-placeholder', 'text-placeholder'],
];

describe('登录页文字档 = 主界面墨水阶梯', () => {
  for (const [mode, theme] of [
    ['light', cindyLight],
    ['dark', cindyDark],
  ] as const) {
    it.each(LOGIN_TEXT_TIERS)(`${mode}: %s 与 %s 同值`, (loginId, inkTierId) => {
      const ink = theme.colors[inkTierId];
      expect(ink, `${theme.id} 缺少 ${inkTierId}`).toMatch(/^rgba\((0, 0, 0|255, 255, 255), 0\.\d+\)$/);
      expect(colorRegistry.resolveDefault(loginId, mode)).toBe(ink);
    });
  }
});
