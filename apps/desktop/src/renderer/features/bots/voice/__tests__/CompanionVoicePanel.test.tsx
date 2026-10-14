// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type VoiceConversationModel } from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  getVoiceInputSettings: () => ({ microphoneDeviceId: null }),
}));
vi.mock('../../BotAvatar', () => ({ BotAvatar: () => <span>Avatar</span> }));
vi.mock('@/voice-input/workletUrl', () => ({ getVoiceInputWorkletUrl: () => 'worklet.js' }));
const audio = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  onPcm16k: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@/voice-input/WebMicAudioEngine', () => ({
  WebMicAudioEngine: class {
    start = audio.start;
    stop = audio.stop;
    onPcm16k = audio.onPcm16k;
  },
}));
vi.mock('../PcmSpeechPlayer', () => ({
  PcmSpeechPlayer: class {
    close = audio.close;
    pause() {}
    resume() {}
    cancel() {}
    async play() {}
  },
}));

import { CompanionVoicePanel } from '../CompanionVoicePanel';
let models: VoiceConversationModel[];
const start = vi.fn(async () => ({ callId: 'call' }));
const refresh = vi.fn(async () => undefined);
beforeEach(() => {
  vi.clearAllMocks();
  models = [];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      voiceConversation: {
        models: async () => models,
        voices: vi.fn(async () => ({ source: 'manual', voices: [] })),
        preview: vi.fn(async () => ({ sampleRate: 24000 })),
        readPreview: vi.fn(async () => ({ pcm: new ArrayBuffer(2), done: true })),
        stopPreview: vi.fn(async () => {}),
        preference: vi.fn(async () => ({ selection: null, customized: false })),
        setPreference: vi.fn(async (_botId, selection) => ({ selection, customized: !!selection })),
        start,
        end: vi.fn(async () => {}),
        onEvent: () => () => {},
      },
      maker: { refreshBuiltinProviderModels: refresh },
      voiceInput: { updateSettings: vi.fn(async () => ({})), onPowerStateChange: () => () => {} },
      onAuthStateChange: () => () => {},
    },
  });
});
afterEach(cleanup);
const configure = vi.fn();
const close = vi.fn();
const panel = (blocked = false) => (
  <CompanionVoicePanel
    bot={{ id: 'bot', name: 'Partner' }}
    sessionId="canonical"
    messages={[]}
    blocked={blocked}
    onSend={vi.fn(async () => true)}
    onClose={close}
    onConfigure={configure}
  />
);

it('starts the saved route directly and releases capture when the panel unmounts', async () => {
  models = [
    {
      id: 'speech',
      name: 'Speech',
      providerId: 'mine',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'speech', voice: 'saved-voice' },
    customized: true,
  });
  const view = render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledWith({
    callId: expect.any(String),
    botId: 'bot',
    sessionId: 'canonical',
    providerId: 'mine',
    agent: 'codex',
    modelId: 'speech',
    voice: 'saved-voice',
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(screen.queryByLabelText('bots.voiceMode.model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  view.unmount();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
});

it.each(['empty', 'missing-model', 'missing-voice', 'unknown-api', 'mismatched-api'])(
  'opens settings for %s without starting ASR or changing preferences',
  async (reason) => {
    models =
      reason === 'empty'
        ? []
        : [
            {
              id: 'speech',
              name: 'Speech',
              providerId: 'mine',
              agent: 'codex',
              ...(reason === 'unknown-api' ? {} : { protocol: 'elevenlabs', protocolLocked: true }),
            },
          ];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: {
        providerId: 'mine',
        agent: 'codex',
        modelId: reason === 'missing-model' ? 'removed' : 'speech',
        voice: reason === 'missing-voice' ? '' : 'saved-voice',
        ...(reason === 'mismatched-api' ? { protocol: 'openai' } : {}),
      },
      customized: true,
    });
    render(panel());
    await waitFor(() => expect(configure).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
    expect(audio.start).not.toHaveBeenCalled();
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  },
);

it('starts once under StrictMode and keeps end and settings actions separate from configuration', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(<StrictMode>{panel()}</StrictMode>);
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.openSettings' }));
  expect(configure).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps permission cards authoritative and resumes only after another explicit action', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(true));
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.confirmation');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.resume' }).hasAttribute('disabled'),
  ).toBe(true);
  view.rerender(panel());
  await act(async () => {});
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resume' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
});

it('does not start a late configuration result after closing', async () => {
  let release!: (value: { selection: null; customized: boolean }) => void;
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(panel());
  view.unmount();
  await act(async () => {
    release({ selection: null, customized: false });
  });
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});

it('keeps a load failure visible and retries without silently switching providers', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockRejectedValueOnce(
    new Error('offline'),
  );
  render(panel());
  await screen.findByText('bots.voiceMode.preferenceError');
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resume' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
});
