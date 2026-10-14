import { expect, it, vi } from 'vitest';
import { ClipboardSync, type RemoteDesktopCapabilities } from '@cindy/device-link';
import { DEFAULT_VIEWER_PREFERENCES } from '../../../shared/remoteDesktopViewer';
import { ViewerSafety } from '../safety';

function fixture() {
  const safety = new ViewerSafety();
  const request = vi.fn(async () => ({ enabled: true })) as any;
  const options = {
    lease: 'lease',
    caps: { privacyScreen: true, hostMute: true, clipboardSync: true } as RemoteDesktopCapabilities,
    preferences: { ...DEFAULT_VIEWER_PREFERENCES, privacyScreen: true, hostMute: true },
    current: () => true,
    clipboardCurrent: () => false,
    request,
  };
  return { safety, options, request };
}
it('applies preferences once and prioritizes privacy failures over mute failures', async () => {
  const { safety, options, request } = fixture();
  request.mockRejectedValue(new Error('DESKTOP_UNAVAILABLE'));
  expect((await safety.tick(options)).notice).toBe('privacyFailed');
  const count = request.mock.calls.length;
  await safety.tick(options);
  expect(request.mock.calls.length).toBe(count);
  safety.invalidate();
  request.mockResolvedValue({ enabled: true });
  expect(await safety.tick(options)).toMatchObject({ privacyActive: true, notice: null });
});
it('does not apply opt-ins without confirmed control', async () => {
  const { safety, options, request } = fixture();
  await safety.tick({ ...options, current: () => false });
  expect(request).not.toHaveBeenCalled();
});
it('focus pause preserves privacy state and does not retry failed mute settings', async () => {
  const { safety, options, request } = fixture();
  request.mockImplementation(async (message: { op: string }) => {
    if (message.op === 'hostMute') throw new Error('DESKTOP_UNAVAILABLE');
    return { enabled: true };
  });
  await safety.tick(options);
  const before = safety.snapshot();
  await safety.pauseClipboard();
  expect(safety.snapshot()).toEqual(before);
  await safety.tick(options);
  expect(
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'privacyScreen'),
  ).toHaveLength(1);
  expect(
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'hostMute'),
  ).toHaveLength(1);
});
it('pauses until old work settles and discards its late success', async () => {
  const { safety, options, request } = fixture();
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = safety.tick(options);
  let paused = false;
  const pause = safety.pause().then(() => {
    paused = true;
  });
  await Promise.resolve();
  expect(paused).toBe(false);
  finish({ enabled: true });
  await Promise.all([pending, pause]);
  expect(safety.snapshot()).toMatchObject({ privacyActive: false, notice: null });
  expect(request).toHaveBeenCalledTimes(1);
});

it('a window-switch pause keeps the stopped read from updating the notice or failure count', async () => {
  const { safety, options } = fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  let fail!: (error: Error) => void;
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  let focused = true;
  const sync = {
    ...options,
    preferences: { ...options.preferences, clipboardSync: true },
    clipboardCurrent: () => focused,
    clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
  };
  try {
    const stale = safety.tick(sync);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    focused = false;
    const paused = safety.pauseClipboard();
    // Pausing stops the in-flight read, which then reports the clipboard as unavailable.
    fail(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
    expect((await stale).notice).toBeNull();
    await paused;
    expect(safety.snapshot().notice).toBeNull();

    // The stale result was not counted: the first real failure backs off 1.5s, not 3s.
    focused = true;
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncFailed');
    now.mockReturnValue(12000);
    await safety.tick(sync);
    expect(tick).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

function syncFixture() {
  const { safety, options, request } = fixture();
  const clipboardEnables = () =>
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'clipboardSync');
  return {
    safety,
    request,
    clipboardEnables,
    sync: {
      ...options,
      preferences: { ...options.preferences, clipboardSync: true },
      clipboardCurrent: () => true,
      clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
    },
  };
}

it('a window-switch pause keeps the computer sync enabled instead of toggling it', async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const tick = vi.spyOn(ClipboardSync.prototype, 'tick').mockResolvedValue(undefined);
  try {
    await safety.tick(sync);
    await safety.pauseClipboard();
    await safety.tick(sync);
    expect(clipboardEnables()).toHaveLength(1);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    tick.mockRestore();
  }
});

it('a locked computer waits at a fixed interval with its own status, never growing the backoff', async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncWaiting');
    for (const [at, calls] of [
      [11000, 1],
      [11500, 2],
      [12500, 2],
      [13000, 3],
      [14500, 4],
    ] as const) {
      now.mockReturnValue(at);
      await safety.tick(sync);
      expect(tick).toHaveBeenCalledTimes(calls);
    }
    expect(safety.snapshot().notice).toBeNull();
    // The computer refused sync while locked, so each attempt re-enabled it first.
    expect(clipboardEnables()).toHaveLength(4);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it('a copy mid-read keeps the status; other failures back off to 5s at most and wake retries at once', async () => {
  const { safety, sync } = syncFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_CHANGED'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBeNull();
    // 1.5s later the unexplained failures start: 1.5s, 3s, then capped at 5s.
    for (const [at, calls, notice] of [
      [11500, 2, 'clipboardSyncFailed'],
      [12900, 2, 'clipboardSyncFailed'],
      [13000, 3, 'clipboardSyncFailed'],
      [15900, 3, 'clipboardSyncFailed'],
      [16000, 4, 'clipboardSyncFailed'],
      [20900, 4, 'clipboardSyncFailed'],
    ] as const) {
      now.mockReturnValue(at);
      expect((await safety.tick(sync)).notice).toBe(notice);
      expect(tick).toHaveBeenCalledTimes(calls);
    }
    // Regained focus or a shortcut: no waiting, and the failure count starts over.
    safety.wake();
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncFailed');
    expect(tick).toHaveBeenCalledTimes(5);
    now.mockReturnValue(22400);
    expect((await safety.tick(sync)).notice).toBeNull();
    expect(tick).toHaveBeenCalledTimes(6);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it('a permission failure still waits for an explicit retry', async () => {
  const { safety, sync } = syncFixture();
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_PERMISSION_DENIED'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncPermission');
    safety.wake();
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncPermission');
    expect(tick).toHaveBeenCalledOnce();
  } finally {
    tick.mockRestore();
  }
});

it("this computer's own clipboard helper failing is a plain failure, not the other computer being locked", async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const version = vi.fn(async () => {
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  });
  expect((await safety.tick({ ...sync, clipboard: { ...sync.clipboard, version } })).notice).toBe(
    'clipboardSyncFailed',
  );
  expect(version).toHaveBeenCalled();
  await safety.tick({ ...sync, clipboard: { ...sync.clipboard, version } });
  expect(clipboardEnables()).toHaveLength(1);
});

it('keeps conflict feedback until content is actually synchronized', async () => {
  const { safety, options } = fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_CONFLICT'))
    .mockResolvedValue(undefined);
  const sync = {
    ...options,
    preferences: { ...options.preferences, clipboardSync: true },
    clipboardCurrent: () => true,
    clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
  };
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncConflict');
    now.mockReturnValue(12000);
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncConflict');
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});
