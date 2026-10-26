import assert from 'node:assert/strict';
export default {
  name: 'region-capture', entry: './capture-fixture.tsx', viewport: { width: 900, height: 700 },
  real: 'RegionScreenshotOverlay, ScrollCaptureOverlay, LiveCapturePanel, ScrollCapture, CaptureRecorder, real Chromium canvas/MediaRecorder and GIF encoding',
  notCovered: 'Native screen acquisition, global keyboard sampling, macOS permissions and native save dialogs; frame source is synthetic.',
  cases: {
    default: { about: 'Scroll overlapping text, finish, export the actual stitched pixels' },
    idle: { about: 'Repainting before the first scroll keeps the gesture hint, then scrolling still exports a long image' },
    inactive: { about: 'Only the display under the pointer shows capture controls' },
    drag: { about: 'Move the top toolbar horizontally without selecting pixels or leaving screen bounds' },
    video: { about: 'Record, annotate, pause/resume, save and decode a WebM' },
    gif: { about: 'Record, annotate, pause/resume, save and decode an animated GIF' },
  },
  async ready(page) { await page.locator('canvas').first().waitFor(); },
  async check(page, ui) {
    const isScroll = ui.case === 'default' || ui.case === 'idle';
    const button = async (key) => page.getByRole('button', { name: await ui.t(key), exact: true });
    // e2e: exercise the real pointer capture path. Dragging the handle must move
    // only the toolbar, retain its top position, and keep both ends reachable.
    if (ui.case === 'drag') {
      const handle = await button('regionScreenshot.moveToolbar');
      const bar = handle.locator('..');
      const initial = await bar.boundingBox();
      const move = async (x, y) => {
        const grip = await handle.boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down(); await page.mouse.move(x, y, { steps: 10 }); await page.mouse.up();
      };
      const grip = await handle.boundingBox();
      // Longer translations have less free space. Exercise an unconstrained
      // move first; the following drags independently verify both screen edges.
      const distance = Math.min(100, (page.viewportSize().width - initial.width) / 4);
      assert.ok(distance > 0);
      await move(grip.x + grip.width / 2 + distance, grip.y + 150);
      let bounds = await bar.boundingBox();
      assert.ok(Math.abs(bounds.x - initial.x - distance) < 1);
      assert.equal(bounds.y, initial.y);
      await move(899, 400);
      bounds = await bar.boundingBox();
      assert.ok(bounds.x + bounds.width <= 893);
      await move(1, 400);
      const leftBounds = await bar.boundingBox();
      // CSS centering can round a fractional width by half a layout subpixel.
      assert.ok(Math.abs(leftBounds.x - 8) < 0.02, JSON.stringify(leftBounds));
      await (await button('regionScreenshot.live.scroll')).click();
      assert.equal(await (await button('regionScreenshot.live.startScroll')).count(), 0, 'dragging the toolbar does not create a capture selection');
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0);
      await ui.capture('dragged');
      return;
    }
    // e2e regression: previously every monitor showed its own mode bar. A begin
    // payload with no local cursor models the second screen; entry/exit must
    // transfer visible controls without relying on emulated document focus.
    if (ui.case === 'inactive') {
      const mode = await button('regionScreenshot.live.scroll');
      assert.equal(await mode.count(), 0);
      await page.mouse.move(20, 100);
      await mode.waitFor({ state: 'visible' });
      await ui.capture('active');
      await page.mouse.move(-10, -10);
      await mode.waitFor({ state: 'hidden' });
      return;
    }
    if (!isScroll) await (await button('regionScreenshot.live.start')).click();
    else {
      const modeButton = await button('regionScreenshot.live.scroll');
      assert.ok((await modeButton.boundingBox()).y < 60, 'capture modes are at the screen top before selection');
      await modeButton.click();
      assert.equal(await page.locator('button[aria-pressed="true"]').count(), 1);
      await page.mouse.move(100, 100); await page.mouse.down();
      await page.mouse.move(580, 340, { steps: 8 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0, 'choosing a mode and a region does not start capture');
      await ui.capture('ready');
      await (await button('regionScreenshot.live.startScroll')).click();
      assert.equal(await (await button('regionScreenshot.live.pause')).count(), 0, 'scrolling has no separate capture toolbar');
      assert.equal(await page.getByRole('complementary').count(), 1, 'the selection has an inline stitched preview');
    }
    if (ui.case === 'idle') {
      // e2e regression: the old panel displayed a lost-overlap warning after
      // 1.5 seconds even though the source had only repainted without scrolling.
      await page.waitForFunction(() => window.captureQa.frames >= 10);
      assert.equal(await page.getByRole('status').innerText(), await ui.t('regionScreenshot.live.scrollHint'));
      await ui.capture('waiting-for-scroll');
      await page.evaluate(() => { window.captureQa.idle = false; });
      await page.waitForFunction(() => window.captureQa.scrollFrames >= 3);
    }
    await page.waitForFunction(() => window.captureQa.frames >= 3);
    if (isScroll) {
      await (await button('regionScreenshot.live.autoScroll')).click();
      await page.waitForFunction(() => window.captureQa.automatic);
      await (await button('regionScreenshot.live.stopScroll')).click();
      await page.waitForFunction(() => !window.captureQa.automatic);
      await ui.capture('scrolling');
      if (ui.case === 'default') {
        // Regression: a growing screenshot previously shrank to fit the panel.
        // Real canvas output must retain its width, scroll to new content and allow review.
        const thumbnail = page.getByRole('complementary').locator('canvas');
        const width = await thumbnail.evaluate(el => el.width);
        await page.evaluate(() => { window.captureQa.scrollLimit = 600; });
        await page.waitForFunction(() => window.captureQa.scrollFrames >= 21);
        assert.equal(await thumbnail.evaluate(el => el.width), width);
        const viewport = thumbnail.locator('..');
        assert.ok(await viewport.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
        await ui.capture('long-preview');
        await viewport.hover(); await page.mouse.wheel(0, -1000);
        await page.waitForFunction(() => document.querySelector('aside canvas').parentElement.scrollTop === 0);
      }
    }
    if (!isScroll) {
    await (await button('regionScreenshot.live.pause')).click();
    const frames = await page.evaluate(() => window.captureQa.frames);
    // e2e: cross a real capture tick to prove that the user-visible pause stops sampling.
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.captureQa.frames), frames);
    await ui.capture('paused');
    if (!isScroll) {
      await (await button('regionScreenshot.tools.arrow')).click();
      const box = await page.locator('canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
      await page.mouse.up();
    }
    await (await button('regionScreenshot.live.resume')).click();
    await page.waitForFunction((previous) => window.captureQa.frames >= previous + 3, frames);
    await ui.capture('capturing');
    }
    await (await button(isScroll ? 'regionScreenshot.live.edit' : 'regionScreenshot.live.finish')).click();
    if (isScroll) {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForFunction(() => window.captureQa.restored);
      const arrow = await ui.t('regionScreenshot.tools.arrow');
      await page.getByRole('button', { name: `${arrow} (A)`, exact: true }).click();
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 }); await page.mouse.up();
      await ui.capture('original-editor');
      await page.getByRole('button', { name: `${await ui.t('regionScreenshot.save')} (Ctrl+S)`, exact: true }).click();
      await page.waitForFunction(() => window.captureQa.exportedHeight > 240);
      assert.ok(await page.evaluate(() => window.captureQa.annotationPixels > 0), 'original editor annotations are included in the full-resolution export');
    } else {
      await (await button('regionScreenshot.save')).waitFor();
      await (await button('regionScreenshot.save')).click();
      await page.waitForFunction(() => window.captureQa.saved?.length > 0);
      const clip = await page.evaluate(() => ({ saved: Array.from(window.captureQa.saved), format: window.captureQa.format }));
      // Playback is an independent decoder check. The fixture document deliberately disallows media.
      const playback = await page.context().newPage();
      let decoded;
      try { decoded = await playback.evaluate(async ({ saved, format }) => {
        saved = new Uint8Array(saved);
        const url = URL.createObjectURL(new Blob([saved], { type: format === 'gif' ? 'image/gif' : 'video/webm' }));
        try {
          if (format === 'gif') {
            const image = new Image(); image.src = url; await image.decode();
            return { width: image.naturalWidth, height: image.naturalHeight };
          }
          const video = document.createElement('video'); video.muted = true; video.src = url;
          await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
          const size = { width: video.videoWidth, height: video.videoHeight };
          video.removeAttribute('src'); video.load();
          return size;
        } finally { URL.revokeObjectURL(url); }
      }, clip); } finally { await playback.close(); }
      assert.deepEqual(decoded, { width: 480, height: 240 });
    }
  },
};
