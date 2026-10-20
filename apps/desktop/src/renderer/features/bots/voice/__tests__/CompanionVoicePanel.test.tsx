// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  type VoiceConversationModel,
  type VoiceConversationEvent,
} from '@/../shared/voiceConversation';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { seconds?: number }) =>
      options?.seconds ? `${key}:${options.seconds}` : key,
  }),
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => log }));
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
let inputEvent: (event: VoiceConversationEvent) => void;
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
        classifyExit: vi.fn(async () => false),
        setInputMuted: vi.fn(async () => ({ inputGeneration: 2 })),
        finishUtterance: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        onEvent: (callback: typeof inputEvent) => {
          inputEvent = callback;
          return () => {
            inputEvent = () => {};
          };
        },
      },
      maker: { refreshBuiltinProviderModels: refresh },
      voiceInput: { updateSettings: vi.fn(async () => ({})), onPowerStateChange: () => () => {} },
      onAuthStateChange: () => () => {},
    },
  });
});
afterEach(cleanup);
afterEach(() => vi.useRealTimers());
const configure = vi.fn();
const close = vi.fn();
const panel = (blocked = false, taskBusy = false, open = true) => (
  <CompanionVoicePanel
    open={open}
    bot={{ id: 'bot', name: 'Partner' }}
    sessionId="canonical"
    messages={[]}
    blocked={blocked}
    taskBusy={taskBusy}
    onSend={vi.fn(async (_text, created) => {
      created('input');
      return true;
    })}
    onClose={close}
    onConfigure={configure}
  />
);

// Exit animation retains the real panel briefly. The old unmount-only cleanup
// would keep recording/playing until that animation ended. Existing cases only
// unmount immediately; these unit cases close a still-mounted panel and reopen
// it, or resolve an old configuration load during exit. Audio/API boundaries are
// faked; the production panel and controller own all lifecycle transitions.
it('releases voice immediately during exit and can reopen before the visual unmount', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(false, false, false));
  await act(async () => {});
  expect(start).not.toHaveBeenCalled();
  view.rerender(panel());
  await act(async () => {});
  expect(audio.start).toHaveBeenCalledOnce();
  view.rerender(panel(false, false, false));
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.close).toHaveBeenCalledOnce();
  expect(log.info).toHaveBeenCalledWith('voice mode ended', {
    callId: 'call',
    reason: 'view_closed',
  });
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
  // Freeze the last visible state rather than flashing idle/Resume during exit.
  expect(screen.getByRole('status', { hidden: true }).textContent).toBe(
    'bots.voiceMode.status.listening',
  );

  await act(() => vi.advanceTimersByTimeAsync(50));
  view.rerender(panel());
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(audio.start).toHaveBeenCalledTimes(2);
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  view.rerender(panel(false, false, false));
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(screen.queryByRole('status', { hidden: true })).toBeNull();
  expect(audio.stop).toHaveBeenCalledTimes(2);
});

it('ignores late configuration while the closed toolbar is still fading out', async () => {
  let release!: (value: { selection: null; customized: boolean }) => void;
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.preference).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(panel());
  view.rerender(panel(false, false, false));
  await act(async () => {
    release({ selection: null, customized: false });
  });
  expect(start).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});

// Contract: companion-voice-mode.md auto-exit warning. Existing panel cases only
// covered manual End. Minimal regression: 60s idle has no visible/cancellable
// warning. Unit/jsdom; real controller, fake timers and audio/API boundaries.
// Standalone vitest run: 1.64s wall time, including the toolbar disclosure cases.
it('shows a quiet countdown, lets the user keep the call, then closes through the host callback', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.idle');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:10');
  expect(screen.getByRole('timer').getAttribute('aria-live')).toBe('off');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  expect(screen.queryByRole('timer')).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: 'bots.voiceMode.title' }),
  );
  expect(close).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(70_000));
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledWith('call');
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('timer')).toBeNull();
});

it('keeps task activity authoritative, but allows an intentional farewell without stopping the task', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  const view = render(panel(false, true));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(screen.queryByRole('timer')).toBeNull();
  view.rerender(panel(false, false));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByRole('timer')).toBeTruthy();
  view.rerender(panel(false, true));
  expect(screen.queryByRole('timer')).toBeNull();
  act(() => inputEvent({ callId: 'call', event: { type: 'utterance', id: 'bye', text: '再见' } }));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.farewell');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:3');
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(close).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
});

it('shows the same cancellable three-second control for a semantic exit', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(true);
  render(panel());
  await act(async () => {});
  await act(async () =>
    inputEvent({
      callId: 'call',
      event: { type: 'utterance', id: 'natural-exit', text: '今天先聊到这里吧' },
    }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.semantic');
  expect(screen.getByRole('timer').textContent).toBe('bots.voiceMode.exit.countdown:3');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('timer')).toBeNull();
});

// Real panel/controller with a deferred send: waiting must remain cancellable,
// must not advertise a zero-second timer, and cannot close before acceptance.
it('shows sending-before-exit until accepted, then closes immediately without a countdown', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
    'submit_then_exit',
  );
  let accept!: () => void;
  const onSend = vi.fn(
    async (_text: string, created: (id: string) => void, current: () => boolean) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      created('input');
      return true;
    },
  );
  render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
  await act(async () => {});
  await act(async () =>
    inputEvent({
      callId: 'call',
      event: { type: 'utterance', id: 'compound', text: '帮我查资料，然后退出语音模式' },
    }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
  expect(screen.queryByRole('timer')).toBeNull();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(close).not.toHaveBeenCalled();
  await act(async () => accept());
  expect(onSend).toHaveBeenCalledOnce();
  expect(onSend.mock.calls[0]![0]).toBe('帮我查资料，然后退出语音模式');
  expect(close).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).toHaveBeenCalledOnce();
  expect(screen.queryByRole('timer')).toBeNull();
});

// Acceptance coverage through the real panel + controller: the controller's
// state tests alone cannot detect a missing full-text recovery view, a broken
// Retry button, or a Cancel button wired to closing the panel. Inject only the
// send boundary (false/throw/deferred acknowledgement), with no live account.
// Contract: companion-voice-mode.md, original-text retention and cancellable
// submit-then-exit. Unit/jsdom with fake time.
it.each(['rejected', 'throw'] as const)(
  'shows the complete original after send %s and retries it once without reviving exit',
  async (failure) => {
    vi.useFakeTimers();
    models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
    vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
      'submit_then_exit',
    );
    const text = '请在后台整理一份三条的周末读书计划，收到这条请求就退出语音模式，不用等你完成。';
    let fail!: () => void;
    const accepted: string[] = [];
    const onSend = vi.fn(
      async (original: string, created: (id: string) => void, current: () => boolean) => {
        expect(current()).toBe(true);
        accepted.push(original);
        created('accepted-input');
        return true;
      },
    );
    onSend.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        fail = done;
      });
      if (failure === 'throw') throw new Error('injected send failure');
      return false;
    });
    render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
    await act(async () => {});
    await act(async () =>
      inputEvent({ callId: 'call', event: { type: 'utterance', id: 'compound', text } }),
    );
    expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
    await act(async () => fail());
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('bots.voiceMode.errors.send');
    expect(screen.queryByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(accepted).toEqual([]);
    expect(onSend).toHaveBeenCalledOnce();

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.retrySend' })),
    );
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(onSend.mock.calls.map(([original]) => original)).toEqual([text, text]);
    expect(accepted).toEqual([text]);
    expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(window.electronAPI.voiceConversation.classifyExit).toHaveBeenCalledOnce();
  },
);

it('cancels through the waiting-for-send button and keeps the accepted work without closing', async () => {
  vi.useFakeTimers();
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  vi.mocked(window.electronAPI.voiceConversation.classifyExit).mockResolvedValue(
    'submit_then_exit',
  );
  const text = '帮我用三条列出整理桌面的步骤，然后退出语音模式。';
  let accept!: () => void;
  const accepted: string[] = [];
  const onSend = vi.fn(
    async (original: string, created: (id: string) => void, current: () => boolean) => {
      await new Promise<void>((done) => {
        accept = done;
      });
      expect(current()).toBe(true);
      accepted.push(original);
      created('accepted-input');
      return true;
    },
  );
  render(<CompanionVoicePanel {...panel().props} onSend={onSend} />);
  await act(async () => {});
  await act(async () =>
    inputEvent({ callId: 'call', event: { type: 'utterance', id: 'compound', text } }),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.exit.sending');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.exit.cancel' }));
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.exit.cancel' })).toBeNull();
  expect(screen.queryByRole('timer')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => accept());
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(accepted).toEqual([text]);
  expect(onSend).toHaveBeenCalledOnce();
  expect(screen.queryByText(text)).toBeNull();
  expect(screen.queryByRole('timer')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(audio.stop).not.toHaveBeenCalled();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});

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
  expect(log.info).toHaveBeenCalledWith('voice mode ended', {
    callId: 'call',
    reason: 'view_cleanup',
  });
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
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
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
  // The compact toolbar has no separate close icon: End remains reachable even
  // when a permission card owns the composer and capture cannot be resumed.
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.end' }));
  expect(close).toHaveBeenCalledOnce();
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

it('distinguishes ASR connection from microphone startup, with explicit microphone-only controls', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  let connected!: (value: { callId: string }) => void;
  let capturing!: () => void;
  start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connected = resolve;
      }),
  );
  audio.start.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        capturing = resolve;
      }),
  );
  const view = render(panel());
  await waitFor(() => expect(start).toHaveBeenCalledOnce());
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.connecting');
  expect(screen.getByRole('button', { name: 'bots.voiceMode.mute' }).hasAttribute('disabled')).toBe(
    true,
  );
  await act(async () => {
    connected({ callId: 'call' });
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.microphone');
  expect(
    view.container.querySelector('[data-activity="microphone"] .animate-spinner'),
  ).not.toBeNull();
  expect(view.container.querySelector('.companion-voice-meter')).toBeNull();
  await act(async () => {
    capturing();
  });
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(view.container.querySelector('.companion-voice-meter')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(window.electronAPI.voiceConversation.setInputMuted).toHaveBeenCalledWith('call', true),
  );
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.muted');
  expect(
    screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByText('bots.voiceMode.mutedHint')).toBeTruthy();
  expect(view.container.querySelector('.companion-voice-meter')).toBeNull();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.unmute' }));
  await waitFor(() => expect(audio.start).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('status').textContent).toBe('bots.voiceMode.status.listening');
  expect(start).toHaveBeenCalledOnce();
});

it('keeps Send secondary and preserves a visible unsent draft when the microphone is muted', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  act(() => inputEvent({ callId: 'call', event: { type: 'draft', text: 'unfinished thought' } }));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.send' }));
  expect(window.electronAPI.voiceConversation.finishUtterance).toHaveBeenCalledWith('call');
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.getByText('bots.voiceMode.unsent')).toBeTruthy();
  expect(screen.getByText('unfinished thought')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.voiceMode.send' })).toBeTruthy();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();

  // Production disclosure contract: folding text must not replace the call,
  // discard the unsent draft or resume a muted microphone. Old panel coverage
  // had no disclosure. Minimal input: one draft, then mute + expand/Escape.
  // Unit/jsdom, existing real controller with only audio/API boundaries faked.
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }));
  expect(screen.getByText('unfinished thought')).toBeTruthy();
  const disclosure = screen.getByRole('button', { name: 'bots.voiceMode.hideDetails' });
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(disclosure, { key: 'Escape' });
  expect(screen.getByText('unfinished thought')).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'bots.voiceMode.showDetails' }),
  );
  expect(audio.start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});

it('offers unmute again after capture fails without replacing the call with a full reconnect', async () => {
  models = [{ id: 'tts', name: 'Speech', defaultVoice: 'alloy' }];
  render(panel());
  await waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.mute' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  audio.start.mockRejectedValueOnce(new Error('device unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'bots.voiceMode.unmute' }));
  await screen.findByText('bots.voiceMode.microphoneResumeError');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'bots.voiceMode.unmute' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.resume' })).toBeNull();
  expect(window.electronAPI.voiceConversation.end).not.toHaveBeenCalled();
});
