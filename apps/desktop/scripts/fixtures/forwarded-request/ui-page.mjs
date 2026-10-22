import assert from 'node:assert/strict';
export default {
  name: 'forwarded-request', entry: './forwarded-request-fixture.tsx', viewport: { width: 760, height: 860 },
  real: 'BotDirectMessageView, BotDirectMessageCard, UserMessage and production forwarded-request formatter/display projection',
  notCovered: 'IPC transport, persistence and native mobile; historical API bodies are supplied by the fixture',
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/features/bots/botStore': 'const profiles = []; export const useBotProfiles = () => profiles;',
    'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;',
  },
  cases: {
    default: { about: 'Historical private-thread body: paragraphs, lists, code and attribution' },
    task: { about: 'Attributed task input uses the same readable projection' },
    card: { about: 'Expand a historical private-thread card' },
  },
  async check(page, ui) {
    if (ui.case === 'task') {
      const expand = page.getByRole('button', { name: await ui.t('chat.userMessage.expandLongMessage'), exact: true });
      if (await expand.count()) await expand.click();
    }
    if (ui.case === 'card') await page.getByRole('button', { name: await ui.t('bots.directMessage.expandThread'), exact: true }).click();
    await page.getByText('最后一段：只检查，不发布。', { exact: false }).last().waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('第一段：消息现在正常换行。'));
    assert.ok(text.includes('const newline = "\\n";'));
    assert.ok(!text.includes('第一段：消息现在正常换行。\\n\\n'));
  },
};
