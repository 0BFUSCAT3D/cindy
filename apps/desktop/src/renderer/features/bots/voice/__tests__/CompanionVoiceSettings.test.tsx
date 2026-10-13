// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { CompanionVoiceSettings } from '../CompanionVoiceSettings';
const sessionState = vi.hoisted(() => ({ value: {} }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeLight: () => () => {}, getLightSnapshot: () => sessionState.value },
  EMPTY_LIGHT_STATE: {},
}));
let models: VoiceConversationModel[];
const start = vi.fn(async () => ({ callId: 'call' }));
const refresh = vi.fn(async () => undefined);
beforeEach(() => {
  vi.clearAllMocks();
  models = [];
  sessionState.value = {};
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
const renderSettings = (botId = 'bot') =>
  render(<CompanionVoiceSettings botId={botId} sessionId="canonical" />);

it('shows a useful empty state without requesting a microphone or inventing models', async () => {
  renderSettings();
  await screen.findByText('bots.voiceMode.noModels');
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith('xd'));
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
  renderSettings();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
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
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'b', agent: 'codex', modelId: 'same' }),
    ),
  );
});

it('requires an explicit API choice for an unknown endpoint before previewing', async () => {
  models = [
    { id: 'private', name: 'Voice', providerId: 'custom', agent: 'codex', defaultVoice: '' },
  ];
  renderSettings();
  await screen.findByText('bots.voiceMode.protocolHint');
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voiceId'), {
    target: { value: 'voice-id' },
  });
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('bots.voiceMode.protocol'), {
    target: { value: 'elevenlabs' },
  });
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voiceId'), {
    target: { value: 'voice-id' },
  });
  fireEvent.blur(screen.getByLabelText('bots.voiceMode.voiceId'));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({ protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'custom', protocol: 'elevenlabs', voice: 'voice-id' }),
    ),
  );
});

it.each(['elevenlabs', 'minimax', 'openai'] as const)(
  'shows only the fixed %s API for an official endpoint and keeps its saved voice',
  async (protocol) => {
    models = [
      {
        id: 'speech',
        name: 'Speech',
        providerId: 'official',
        agent: 'codex',
        protocol,
        protocolLocked: true,
      },
    ];
    vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
      selection: {
        providerId: 'official',
        agent: 'codex',
        modelId: 'speech',
        protocol,
        voice: 'saved-voice',
      },
      customized: true,
    });
    renderSettings();
    await screen.findByText('bots.voiceMode.protocolAutomaticHint');
    const field = screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement;
    expect(field.disabled).toBe(true);
    expect(field.value).toBe(protocol);
    expect(
      Array.from(field.options)
        .map((option) => option.value)
        .filter(Boolean),
    ).toEqual([protocol]);
    await waitFor(() =>
      expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
        'saved-voice',
      ),
    );
    expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
    await waitFor(() =>
      expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'speech', voice: 'saved-voice' }),
      ),
    );
    expect(
      vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0],
    ).not.toHaveProperty('protocol');
  },
);

it('repairs a saved API mismatch without reusing its voice or rewriting preferences on load', async () => {
  models = [
    {
      id: 'eleven_flash_v2_5',
      name: 'ElevenLabs',
      providerId: 'official',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: 'openai',
      voice: 'alloy',
    },
    customized: true,
  });
  renderSettings();
  await screen.findByText('bots.voiceMode.protocolCorrectedHint');
  expect((screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement).value).toBe(
    'elevenlabs',
  );
  const voice = screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement;
  expect(voice.value).toBe('');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalledWith({
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: undefined,
    }),
  );
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
  fireEvent.change(voice, { target: { value: 'eleven-voice-id' } });
  fireEvent.blur(voice);
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', {
      providerId: 'official',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      voice: 'eleven-voice-id',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'eleven-voice-id' }),
    ),
  );
  expect(
    vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0],
  ).not.toHaveProperty('protocol');
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
});

it('keeps a proxy API override and unlocks the selector after switching away from an official model', async () => {
  models = [
    {
      id: 'eleven_flash_v2_5',
      name: 'Official',
      providerId: 'official',
      agent: 'codex',
      protocol: 'elevenlabs',
      protocolLocked: true,
    },
    { id: 'eleven_flash_v2_5', name: 'Proxy', providerId: 'proxy', agent: 'codex' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: {
      providerId: 'proxy',
      agent: 'codex',
      modelId: 'eleven_flash_v2_5',
      protocol: 'openai',
      voice: 'proxy-voice',
    },
    customized: true,
  });
  renderSettings();
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement).value).toBe(
      'openai',
    ),
  );
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'proxy-voice',
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
      target: { value: voiceModelKey(models[0]) },
    });
  });
  expect((screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement).disabled).toBe(
    true,
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
      target: { value: voiceModelKey(models[1]) },
    });
  });
  const field = screen.getByLabelText('bots.voiceMode.protocol') as HTMLSelectElement;
  expect(field.disabled).toBe(false);
  expect(
    Array.from(field.options)
      .map((option) => option.value)
      .filter(Boolean),
  ).toEqual(['openai', 'elevenlabs', 'minimax']);
  await act(async () => {
    fireEvent.change(field, { target: { value: 'minimax' } });
  });
  expect(field.value).toBe('minimax');
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
  renderSettings();
  await screen.findByText('bots.voiceMode.modelUnavailable');
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.preview' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.resetPreference' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith('bot', null),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
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
  const first = renderSettings('a');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
      'nova',
    ),
  );
  first.unmount();
  renderSettings('b');
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
      'alloy',
    ),
  );
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('retries a failed preference load and still lists BYOK when Gateway refresh fails', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockRejectedValueOnce(
    new Error('load failed'),
  );
  refresh.mockRejectedValueOnce(new Error('Gateway unavailable'));
  renderSettings();
  await screen.findByText('bots.voiceMode.preferenceError');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refresh' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(window.electronAPI.voiceConversation.preference).toHaveBeenCalledTimes(2);
});

it('selects an account voice, keeps manual IDs on catalog failure, and previews without capturing audio', async () => {
  models = [
    { id: 'speech', name: 'MiniMax', providerId: 'mine', agent: 'codex', protocol: 'minimax' },
  ];
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockResolvedValueOnce({
      source: 'provider',
      voices: [{ id: 'Chinese (Mandarin)_News_Anchor', name: 'News Anchor' }],
    })
    .mockRejectedValueOnce(new Error('offline'));
  renderSettings();
  await screen.findByRole('option', { name: 'News Anchor · Chinese (Mandarin)_News_Anchor' });
  fireEvent.change(screen.getByLabelText('bots.voiceMode.voice'), {
    target: { value: 'voice:Chinese (Mandarin)_News_Anchor' },
  });
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenCalledWith(
      'bot',
      expect.objectContaining({
        voice: 'Chinese (Mandarin)_News_Anchor',
        providerId: 'mine',
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.preview' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'speech',
        voice: 'Chinese (Mandarin)_News_Anchor',
        text: 'bots.voiceMode.previewText',
      }),
    ),
  );
  expect(
    vi.mocked(window.electronAPI.voiceConversation.preview).mock.calls[0][0].protocol,
  ).toBeUndefined();
  expect(
    vi.mocked(window.electronAPI.voiceConversation.voices).mock.calls[0][0].protocol,
  ).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(audio.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.refreshVoices' }));
  await screen.findByText('bots.voiceMode.voicesError');
  expect((screen.getByLabelText('bots.voiceMode.voiceId') as HTMLInputElement).value).toBe(
    'Chinese (Mandarin)_News_Anchor',
  );
});

it('resets a voice when switching models on the same connection and ignores a late catalog', async () => {
  models = ['first', 'second'].map((id) => ({
    id,
    name: id,
    providerId: 'mine',
    agent: 'codex',
    protocol: 'elevenlabs',
  }));
  vi.mocked(window.electronAPI.voiceConversation.preference).mockResolvedValue({
    selection: { providerId: 'mine', agent: 'codex', modelId: 'first', voice: 'private-voice' },
    customized: true,
  });
  let release!: (value: { source: 'provider'; voices: { id: string; name: string }[] }) => void;
  vi.mocked(window.electronAPI.voiceConversation.voices)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    )
    .mockResolvedValue({ source: 'provider', voices: [{ id: 'new', name: 'New voice' }] });
  renderSettings();
  await waitFor(() => expect(window.electronAPI.voiceConversation.voices).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('bots.voiceMode.model'), {
    target: { value: voiceModelKey(models[1]) },
  });
  await screen.findByRole('option', { name: 'New voice · new' });
  expect((screen.getByLabelText('bots.voiceMode.voice') as HTMLSelectElement).value).toBe('');
  expect(screen.queryByLabelText('bots.voiceMode.voiceId')).toBeNull();
  release({ source: 'provider', voices: [{ id: 'old', name: 'Old voice' }] });
  await waitFor(() => expect(screen.queryByRole('option', { name: 'Old voice · old' })).toBeNull());
  expect(window.electronAPI.voiceConversation.setPreference).not.toHaveBeenCalled();
});

it('flushes a manually typed voice before leaving and keeps the page open on save failure', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const beforeLeaveRef = { current: null as null | (() => Promise<boolean>) };
  render(
    <CompanionVoiceSettings botId="bot" sessionId="canonical" beforeLeaveRef={beforeLeaveRef} />,
  );
  const input = await screen.findByLabelText('bots.voiceMode.voiceId');
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'nova' } });
  vi.mocked(window.electronAPI.voiceConversation.setPreference).mockRejectedValueOnce(
    new Error('disk error'),
  );
  let allowed = true;
  await act(async () => {
    allowed = await beforeLeaveRef.current!();
  });
  expect(allowed).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('bots.voiceMode.preferenceError');
  await act(async () => {
    allowed = await beforeLeaveRef.current!();
  });
  expect(allowed).toBe(true);
  expect(window.electronAPI.voiceConversation.setPreference).toHaveBeenLastCalledWith('bot', {
    modelId: 'tts',
    voice: 'nova',
  });
  expect(start).not.toHaveBeenCalled();
});

it('allows model configuration but disables preview before a canonical conversation exists', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(<CompanionVoiceSettings botId="bot" />);
  await waitFor(() =>
    expect((screen.getByLabelText('bots.voiceMode.model') as HTMLSelectElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByText('bots.voiceMode.previewNeedsChat')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it('blocks preview while the companion is waiting for confirmation', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  sessionState.value = { pendingPermission: { requestId: 'permission' } };
  renderSettings();
  await screen.findByRole('button', { name: 'bots.voiceMode.preview' });
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.preview' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(start).not.toHaveBeenCalled();
});
