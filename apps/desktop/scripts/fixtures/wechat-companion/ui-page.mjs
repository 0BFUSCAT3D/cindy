import assert from 'node:assert/strict';

export default {
  name: 'wechat-companion',
  entry: './wechat-companion-fixture.tsx',
  viewport: { width: 620, height: 900 },
  real: 'BotChannelsPage, WechatBotSection, useWechatBot, existing connection accordion and translations',
  notCovered: 'Real account login, Tencent scan authorization, persisted binding, message delivery, full-app history navigation and live agent execution',
  cases: {
    default: { about: 'New WeChat connection for a teammate', data: {} },
    existing: { about: 'Reuse the already authorized personal WeChat connection', data: { bound: true } },
    assigned: { about: 'Connected teammate and remove-link action', data: { bound: true, companionBotId: 'fixture-cindy' } },
    other: { about: 'Another teammate owns this connection', data: { bound: true, companionBotId: 'fixture-other' } },
    'feishu-hidden-tasks': { about: 'Clickable hidden IM records and independent restart action', data: { hiddenIm: true } },
    'feishu-hidden-tasks-narrow': { about: 'Hidden IM records in a narrow window', data: { hiddenIm: true }, viewport: { width: 360, height: 900 } },
  },
  async check(page, ui) {
    if (ui.data.hiddenIm) {
      await page.locator('[title="拉拉, 徐紫旎, 姚刘浏"]').waitFor({ state: 'visible' });
      const row = page.locator('button').filter({ hasText: '8c9b5c' });
      await row.waitFor({ state: 'visible' });
      const resting = await row.evaluate((el) => getComputedStyle(el).boxShadow);
      assert.equal(resting, 'none', 'hidden record stays frameless at rest');
      // Programmatic focus does not match :focus-visible; request the keyboard treatment.
      await row.evaluate((el) => el.focus({ focusVisible: true }));
      const focused = await row.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          visible: el.matches(':focus-visible'),
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
        };
      });
      assert.equal(focused.visible, true, 'keyboard focus must match :focus-visible');
      assert.notEqual(focused.boxShadow, 'none', 'focus ring must survive the global outline suppression');
      assert.equal(focused.outlineStyle, 'none');
      await row.evaluate((el) => el.blur());
    } else {
      await page.locator('#companion-im-wechat-trigger').click();
    }
  },
};
