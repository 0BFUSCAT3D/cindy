import assert from 'node:assert/strict';

export default {
  name: 'chat-history-resize',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 650 },
  real: 'ThinkingCard, WorkGroupBlock, Collapse, expanded-block memory and immediate disclosure lifecycle',
  notCovered: 'Full MessageStream scrolling, remote transport and actual model execution',
  cases: {
    default: { about: 'Completed thinking: delayed details do not animate height' },
    'thinking-streaming': { about: 'Open thinking: incremental content does not animate height' },
    'work-history': { about: 'Expanded work history: delayed children do not animate height' },
    'work-live': { about: 'Running work preview: new activities do not animate height' },
  },
  async ready(page) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const header = page.locator('[data-card] button[aria-expanded]').first();
    if (
      (await page.locator('main').getAttribute('data-scenario')) !== 'work-live' &&
      (await header.getAttribute('aria-expanded')) === 'false'
    )
      await header.click();
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-card]')
          .getAnimations({ subtree: true })
          .some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity),
    );
  },
  async check(page, ui) {
    const samples = await page.evaluate(async () => {
      const anchor = document.querySelector('[data-reading-anchor]');
      const before = anchor.getBoundingClientRect().top;
      document.querySelector('main > button').click();
      const values = [];
      for (let i = 0; i < 45; i++) {
        await new Promise(requestAnimationFrame);
        values.push(anchor.getBoundingClientRect().top);
      }
      return { before, values };
    });
    const end = samples.values.at(-1);
    assert.ok(Math.abs(end - samples.before) > 20, 'real delayed content changes layout');
    assert.equal(
      samples.values.filter((y) => Math.abs(y - samples.before) > 1 && Math.abs(y - end) > 1)
        .length,
      0,
      'already-open content must not interpolate every delayed height change',
    );
    await ui.capture('delayed-content');
    // A running preview with at most five activities intentionally has no toggle.
    if ((await page.locator('main').getAttribute('data-scenario')) === 'work-live') return;
    const header = page.locator('[data-card] button[aria-expanded]').first();
    await header.click();
    await page.waitForFunction(
      () => !document.querySelector('[data-card]').textContent.includes('第 12 项'),
    );
    const didTransition = await page.evaluate(async () => {
      document.querySelector('[data-card] button[aria-expanded]').click();
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        if (
          document
            .querySelector('[data-card]')
            .getAnimations({ subtree: true })
            .some(
              (a) =>
                a.transitionProperty === 'grid-template-rows' || a.transitionProperty === 'height',
            )
        )
          return true;
      }
      return false;
    });
    assert.equal(didTransition, false, 'chat disclosure renders immediately without moving the following content through intermediate heights');
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-card]')
          .getAnimations({ subtree: true })
          .some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity),
    );
    assert.ok(
      (await page.locator('[data-card]').evaluate((e) => e.getBoundingClientRect().height)) > 100,
      'disclosure finishes fully open',
    );
  },
};
