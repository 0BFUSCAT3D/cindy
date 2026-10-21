import assert from 'node:assert/strict';

export default {
  name: 'ask-user-question',
  entry: './ask-user-question-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'AskUserQuestionPrompt, voice choice draft/confirmation, CompanionVoiceToolbar, question references, prompt shell and themes',
  notCovered: 'Actual microphone/ASR/TTS, task execution, host file contents, browser navigation and remote connectivity',
  cases: {
    default: { about: 'Question with a bare HTML filename and URL', data: { question: '请查看 sidebar-layout-v1.html 后确认这版交互形态是否可以进入正式实现。也可以查看 https://example.com/prototype。' } },
    narrow: { about: 'Long references at 320 px', viewport: { width: 320, height: 600 }, data: { question: '请查看 sidebar-layout-v1.html 或 https://example.com/prototypes/a-very-long-prototype-name-before-approval 后确认。' } },
    unresolved: { about: 'Missing and ambiguous references remain plain text', data: { question: '请查看 missing.html 和 ambiguous.html，文件尚未找到或有重名时保持普通文字。' } },
    'voice-single': { about: 'Voice choice instructions with an active listening toolbar', data: { question: '你希望采用哪种方案？', voice: true } },
    'voice-multi': { about: 'Spoken multi-selection awaits confirmation in the existing card', viewport: { width: 800, height: 700 }, data: { question: '你希望保留哪些方案？', voice: true, multi: true } },
    'voice-narrow': { about: 'Voice confirmation and toolbar at 320 px', viewport: { width: 320, height: 800 }, data: { question: '你希望保留哪些方案？', voice: true, multi: true } },
  },
  async ready(page) {
    await page.getByText('确认原型').waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('voice-')) {
      assert.equal(await page.locator('.companion-voice-toolbar').count(), 1);
      assert.ok(await page.getByRole('status').count() >= 2);
      return;
    }
    if (ui.case !== 'unresolved') await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).waitFor();
    assert.equal(await page.getByRole('link').count(), ui.case === 'unresolved' ? 0 : 2);
    if (ui.case !== 'unresolved') {
      assert.equal(await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline');
    }
  },
};
