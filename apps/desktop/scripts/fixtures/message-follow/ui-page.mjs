import assert from 'node:assert/strict';

export default {
  name: 'message-follow',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 560 },
  real: 'useSmoothMessageFollow, MessageViewport and native ResizeObserver with 100 variable-height rows',
  notCovered: 'Full MessageStream, remote history loading, rich cards and account data',
  cases: {
    default: {
      about: 'Initial virtualized layout and reopening stay still; later content follows smoothly',
    },
  },
  async ready(page) {
    // The screenshot harness defaults to reduced motion; this regression needs
    // actual compositor animation, including on the first mounted frame.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: '重新打开任务', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-initial-motion]')?.getAttribute('data-initial-motion') !== '',
    );
  },
  async check(page, ui) {
    const assertInitial = async () => {
      await page.waitForFunction(
        () =>
          document.querySelector('[data-initial-motion]')?.getAttribute('data-initial-motion') !==
          '',
      );
      assert.ok(
        Number(await page.locator('[data-initial-motion]').getAttribute('data-initial-motion')) < 1,
        'initial layout must not replay as a follow animation',
      );
    };
    await assertInitial();
    await page.getByRole('button', { name: '重新打开任务', exact: true }).click();
    await assertInitial();
    await ui.capture('reopened');
    const didAnimate = await page.evaluate(async () => {
      const content = document.querySelector('[data-thread-items]');
      document.querySelectorAll('button')[1].click();
      for (let frame = 0; frame < 12; frame++) {
        await new Promise(requestAnimationFrame);
        if (content.getAnimations().some((animation) => animation.playState === 'running'))
          return true;
      }
      return false;
    });
    assert.equal(didAnimate, true, 'later content still follows smoothly');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-thread-scroll]');
      return (
        Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 1 &&
        !document
          .querySelector('[data-thread-items]')
          .getAnimations()
          .some((animation) => animation.playState === 'running')
      );
    });
    await ui.capture('new-content');
  },
};
