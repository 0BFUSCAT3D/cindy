import { expect, it } from 'vitest';
import { normalizeVoiceInputSettings } from '../../../shared/voiceInputData.js';
import { companionVoicePreference, updateCompanionVoicePreference } from '../preferences.js';
const a = { providerId: 'a', agent: 'codex' as const, modelId: 'tts', voice: 'alloy' };
const b = { ...a, providerId: 'b', voice: 'nova' };
it('persists each companion independently, preserves legacy inheritance, and deletes only a reset override', () => {
  let settings = normalizeVoiceInputSettings({
    conversationSelection: { modelId: 'old', voice: 'alloy' },
  });
  const update = (id: string, value: typeof a | null) => {
    settings = normalizeVoiceInputSettings({
      ...settings,
      conversationSelections: updateCompanionVoicePreference(settings, id, value),
    });
  };
  update('bot-a', a);
  update('bot-b', b);
  settings = normalizeVoiceInputSettings(JSON.parse(JSON.stringify(settings)));
  expect(companionVoicePreference(settings, 'bot-a')).toEqual({ selection: a, customized: true });
  expect(companionVoicePreference(settings, 'bot-b')).toEqual({ selection: b, customized: true });
  update('bot-a', null);
  expect(settings.conversationSelections!['bot-a']).toBeNull();
  expect(companionVoicePreference(settings, 'bot-a')).toEqual({
    selection: null,
    customized: false,
  });
  expect(companionVoicePreference(settings, 'bot-b').selection).toEqual(b);
  expect(companionVoicePreference(normalizeVoiceInputSettings({}), 'bot-b')).toEqual({
    selection: null,
    customized: false,
  });
});
it('does not read prototype keys or retain malformed saved choices', () => {
  const settings = normalizeVoiceInputSettings({
    conversationSelections: { invalid: { modelId: 'tts', voice: '/' }, valid: a },
  });
  expect(companionVoicePreference(settings, 'toString').selection).toBe(null);
  expect(Object.keys(settings.conversationSelections!)).toEqual(['valid']);
});
