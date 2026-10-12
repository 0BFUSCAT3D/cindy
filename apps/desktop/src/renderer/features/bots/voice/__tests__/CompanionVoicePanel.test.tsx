// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { voiceModelKey, type VoiceConversationModel } from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/select', () => ({
  Select: ({
    label,
    value,
    options,
    onValueChange,
    disabled,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange(value: string): void;
    disabled: boolean;
  }) => (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="" />
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
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
const renderPanel = (blocked = false, botId = 'bot') =>
  render(
    <CompanionVoicePanel
      bot={{ id: botId, name: 'Partner' }}
      sessionId="canonical"
      messages={[]}
      blocked={blocked}
      onSend={vi.fn(async () => true)}
      onClose={vi.fn()}
    />,
  );

it('shows a useful empty state without requesting a microphone or inventing models', async () => {
  renderPanel();
  await screen.findByText('bots.voiceMode.noModels');
  const button = screen.getByRole('button', { name: 'bots.voiceMode.start' });
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button);
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith('xd'));
});

it('opens the chosen voice route and releases capture when the panel unmounts', async () => {
  models = [{ id: 'gateway-speech', name: 'Speech' }];
  const view = renderPanel();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), { target: { value: 'nova' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.start' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledWith({
    callId: expect.any(String),
    botId: 'bot',
    sessionId: 'canonical',
    modelId: 'gateway-speech',
    voice: 'nova',
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  view.unmount();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
});

it('keeps permission cards authoritative and never starts through a pending confirmation', async () => {
  models = [{ id: 'tts', name: 'Speech' }];
  renderPanel(true);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.confirmation'),
  );
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
  ).toBe(true);
});

it('selects the exact BYOK connection for duplicate IDs and persists it for this companion', async () => {
  models = ['a', 'b'].map((providerId) => ({
    id: 'same',
    name: 'Speech',
    providerId,
    providerName: providerId,
    agent: 'codex',
    protocol: 'openai',
    defaultVoice: 'alloy',
  }));
  renderPanel();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.getByRole('option', { name: 'Speech · b' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
      providerId: 'b',
      agent: 'codex',
      modelId: 'same',
      voice: 'alloy',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.start' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'b', agent: 'codex', modelId: 'same' }),
    ),
  );
});

it('requires an explicit API choice for an unknown endpoint before requesting a microphone', async () => {
  models = [
    { id: 'private', name: 'Voice', providerId: 'custom', agent: 'codex', defaultVoice: '' },
  ];
  renderPanel();
  await screen.findByText('bots.voiceMode.protocolHint');
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), {
    target: { value: 'voice-id' },
  });
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('bots.voiceMode.protocol'), {
    target: { value: 'elevenlabs' },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({ protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.start' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'custom', protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
});

it('preserves an unavailable saved connection until the user restores defaults', async () => {
  models = [
    {
      id: 'same',
      name: 'Available',
      providerId: 'other',
      agent: 'codex',
      protocol: 'openai',
      defaultVoice: 'alloy',
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'missing', agent: 'codex', modelId: 'same', voice: 'nova' },
    customized: true,
  });
  renderPanel();
  await screen.findByText('bots.voiceMode.modelUnavailable');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', null),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(start).not.toHaveBeenCalled();
});

it('reloads the right companion preference after reopening and does not save a derived default', async () => {
  models = [{ id: 'tts', name: 'Speech' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockImplementation(async (id) => ({
    selection: { modelId: 'tts', voice: id === 'a' ? 'nova' : 'alloy' },
    customized: true,
  }));
  const first = renderPanel(false, 'a');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLInputElement).value).toBe('nova'),
  );
  first.unmount();
  renderPanel(false, 'b');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLInputElement).value).toBe('alloy'),
  );
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('retries a failed preference load and still lists BYOK when Gateway refresh fails', async () => {
  models = [{ id: 'tts', name: 'Speech' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockRejectedValueOnce(
    new Error('load failed'),
  );
  refresh.mockRejectedValueOnce(new Error('Gateway unavailable'));
  renderPanel();
  await screen.findByText('bots.voiceMode.preferenceError');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.start' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(window.electronAPI.voiceConversation.preference).toHaveBeenCalledTimes(2);
});
