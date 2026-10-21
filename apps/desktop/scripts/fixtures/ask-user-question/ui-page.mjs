import assert from 'node:assert/strict';

export default {
  name: 'ask-user-question',
  entry: './ask-user-question-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'AskUserQuestionPrompt, question reference parsing, verified file links, URL links, prompt shell and themes',
  notCovered: 'Actual host file contents, browser navigation, remote connectivity and audio capture; navigation and dictation are covered by component tests',
  // The visual runner uses esbuild, which does not implement Vite ?url assets.
  // Keep the real dictation hook; this fixture must never start audio capture.
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export function getVoiceInputWorkletUrl() { throw new Error("Audio capture is outside this visual fixture"); }',
  },
  cases: {
    default: { about: 'Question with a bare HTML filename and URL', data: { question: '请查看 sidebar-layout-v1.html 后确认这版交互形态是否可以进入正式实现。也可以查看 https://example.com/prototype。' } },
    narrow: { about: 'Long references at 320 px', viewport: { width: 320, height: 600 }, data: { question: '请查看 sidebar-layout-v1.html 或 https://example.com/prototypes/a-very-long-prototype-name-before-approval 后确认。' } },
    unresolved: { about: 'Missing and ambiguous references remain plain text', data: { question: '请查看 missing.html 和 ambiguous.html，文件尚未找到或有重名时保持普通文字。' } },
  },
  async ready(page) {
    await page.getByText('确认原型').waitFor();
  },
  async check(page, ui) {
    const readVoiceFrame = () => page.getByTestId('ask-user-voice').evaluate((node) => ({
      radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    }));
    const voiceFrame = await readVoiceFrame();
    assert.equal(voiceFrame.width, voiceFrame.height);
    assert.ok(voiceFrame.radius >= voiceFrame.height / 2, 'Microphone action frame follows the pill tier (DESIGN §5)');
    if (ui.case !== 'unresolved') await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).waitFor();
    assert.equal(await page.getByRole('link').count(), ui.case === 'unresolved' ? 0 : 2);
    if (ui.case !== 'unresolved') {
      assert.equal(await page.getByRole('link', { name: 'sidebar-layout-v1.html' }).evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline');
    }
    await page.getByRole('button', { name: await ui.t('chat.askUserQuestion.customAnswer') }).click();
    const expandedFrame = await readVoiceFrame();
    assert.equal(expandedFrame.width, 32);
    assert.equal(expandedFrame.height, 32);
    assert.ok(expandedFrame.radius >= 16, 'Expanded microphone action frame follows the same pill tier');
  },
};
