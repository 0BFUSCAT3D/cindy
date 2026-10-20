import assert from 'node:assert/strict';

export default {
  name: 'attachment-access-error',
  entry: './attachment-access-error-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'ErrorMessageCard, error-code decoding, ErrorNotice and localized attachment recovery guidance',
  notCovered: 'macOS WeChat permissions, file I/O and cross-device sending; transport behavior is covered by targeted unit tests',
  cases: {
    default: { about: '#6530: source permission denial explains how to reattach a readable copy' },
    narrow: { about: 'Recovery text wraps at a narrow message width', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
    assert.ok(await page.getByText(await ui.t('chat.remoteError.DEVICE_LINK_MEDIA_ACCESS_DENIED'), { exact: true }).isVisible());
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
  },
};
