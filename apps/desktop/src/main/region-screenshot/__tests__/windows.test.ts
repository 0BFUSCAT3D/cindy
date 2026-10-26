import { EventEmitter } from 'node:events';
import type { Display, NativeImage } from 'electron';
import type { SnapshotHelper } from '../snapshotHost';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  screen: new (class {
    on = vi.fn();
    removeListener = vi.fn();
    getAllDisplays = vi.fn();
    getCursorScreenPoint = () => ({ x: 20, y: 20 });
    dipToScreenPoint = (point: unknown) => point;
    screenToDipRect = (_window: unknown, rect: unknown) => rect;
  })(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  register: vi.fn<(key: string, callback: () => void) => boolean>(() => true),
  unregister: vi.fn(),
  liveCapture: vi.fn(),
  saveRecording: vi.fn(async () => true),
}));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  clipboard: { writeImage: vi.fn(), writeText: vi.fn() },
  screen: mocks.screen,
  globalShortcut: { register: mocks.register, unregister: mocks.unregister },
  nativeImage: {
    createFromBitmap: (
      data: Buffer,
      options: { width: number; height: number; scaleFactor: number },
    ) => ({
      // Electron ImageSkiaRep.GetWidth/GetHeight 返回 DIP，而 toBitmap 返回物理像素。
      getSize: () => ({
        width: options.width / options.scaleFactor,
        height: options.height / options.scaleFactor,
      }),
      toBitmap: () => data,
      isEmpty: () => false,
    }),
  },
  Menu: { buildFromTemplate: vi.fn() },
  ipcMain: { on: (name: string, fn: (...args: unknown[]) => void) => mocks.handlers.set(name, fn) },
}));
vi.mock('../pageWindow', () => ({ createScreenshotPageWindow: mocks.create }));
vi.mock('../compose', () => ({ handOffScreenshotToTask: vi.fn() }));
vi.mock('../save', () => ({ saveScreenshotImage: vi.fn(), saveRegionRecording: mocks.saveRecording }));
vi.mock('../liveCapture', () => ({ captureLiveRegion: mocks.liveCapture, RegionVideoCapture: class { frame = mocks.liveCapture; stop() {} } }));
vi.mock('../../i18n', () => ({ getResolvedMainLocale: () => 'en', t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
import { OverlayPool } from '../overlays';
import { RegionScreenshotSession } from '../session';
import { acquireOverlayEscape } from '../../overlayEscape';
import { closeAllPins, openPin, registerPinIpc } from '../pins';
import { REGION_SCREENSHOT_PIN_CHANNEL as P } from '../../../shared/regionScreenshot';

let nextId = 0;
function fakeWindow() {
  let destroyed = false;
  let visible = false;
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      id: ++nextId,
      mainFrame: {},
      send: vi.fn(),
      sendInputEvent: vi.fn(),
    }),
    isFocused: vi.fn(() => false),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn(),
    setOpacity: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    showInactive: vi.fn(() => {
      visible = true;
      window.emit('show');
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      window.emit('closed');
    }),
    close: vi.fn(() => window.destroy()),
  });
  return window;
}
const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  scaleFactor: 2,
} as Display;
const image = {
  getSize: () => ({ width: 2, height: 2 }),
  toBitmap: () => Buffer.alloc(16),
} as NativeImage;

// 测试价值：OverlayPool/Session/openPin 的真实入口保护首帧、故障退出和 IPC 来源。
// 旧代码没有窗口生命周期测试；最小输入为 unresponsive、未 PAINTED、2x 位图和 workArea 事件。
// tier: unit；Electron 由内存窗口替代，全部时序用假时钟。
describe('screenshot window lifecycle', () => {
  let pool: OverlayPool;
  let windows: ReturnType<typeof fakeWindow>[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    windows = [];
    mocks.create.mockImplementation(() => {
      const window = fakeWindow();
      windows.push(window);
      return window;
    });
    mocks.screen.getAllDisplays.mockReturnValue([display]);
    pool = new OverlayPool();
  });
  afterEach(() => {
    pool.destroyAll();
    closeAllPins();
    vi.useRealTimers();
  });

  // Phase 5/6: same trusted sender/token contract now guards continuing capture and clip export.
  // Existing static-image tests cannot observe a late frame after cancellation or native-dialog retry.
  // Minimal input: one live request, close before the capture promise resolves. tier: unit.
  it('rejects foreign live requests, drops late pixels after cancellation, and never starts key sampling by default', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const cropped = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => cropped };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => cropped } as unknown as NativeImage;
    const keys = vi.fn(async () => ['Ctrl', 'C']);
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: { keys } as unknown as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    const selected = { x: 0, y: 0, width: 400, height: 300 };
    expect(session.startLive(owner, {} as Electron.WebFrameMain, session.token, 'video', selected)).toBeNull();
    expect(session.startLive(owner, owner.mainFrame, 'stale', 'video', selected)).toBeNull();
    expect(session.startLive(owner, owner.mainFrame, session.token, 'video', selected)?.mode).toBe('video');
    let resolve!: (value: unknown) => void;
    mocks.liveCapture.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = session.liveFrame(owner, owner.mainFrame, session.token, false);
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, true)).toBeNull();
    session.close();
    resolve({ width: 400, height: 300, data: new Uint8Array(400 * 300 * 4) });
    expect(await pending).toBeNull();
    expect(keys).not.toHaveBeenCalled();
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, true)).toBeNull();
    expect(mocks.liveCapture).toHaveBeenCalledTimes(1);
  });

  // Long capture returns to the same editor; restoring must stop source sampling and
  // wait for its painted acknowledgement. Earlier tests only close the live session.
  it('restores the original editor after scrolling and exports the full long image', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const result = vi.fn();
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: result });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    const selection = { x: 0, y: 0, width: 400, height: 300 };
    session.startLive(owner, owner.mainFrame, session.token, 'scroll', selection);
    expect(windows[0].setBounds).toHaveBeenLastCalledWith(largeDisplay.bounds, false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(session.restoreEditor(owner, owner.mainFrame, 'stale')).toBe(false);
    expect(session.restoreEditor(owner, owner.mainFrame, session.token)).toBe(true);
    expect(windows[0].setBounds).toHaveBeenLastCalledWith(largeDisplay.bounds, false);
    expect(windows[0].setOpacity).toHaveBeenLastCalledWith(0);
    expect(await session.liveFrame(owner, owner.mainFrame, session.token, true)).toBeNull();
    session.painted(owner, owner.mainFrame, session.token);
    expect(windows[0].setOpacity).toHaveBeenLastCalledWith(1);
    expect(session.export(owner, owner.mainFrame, session.token, { action: 'save', selection, image: { width: 400, height: 1500, data: new Uint8Array(400 * 1500 * 4) } })).toBe(true);
    expect(result.mock.calls[0][0].image.getSize()).toEqual({ width: 400, height: 1500 });
  });

  // Auto scrolling operates on the source app: stale tokens must never trigger it,
  // and stopping while a frame is pending must prevent the next wheel event. tier: unit.
  it('confines automatic scrolling to the owner and stops before a pending frame completes', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const bitmap = { width: 400, height: 300, data: new Uint8Array(400 * 300 * 4) };
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.from(bitmap.data), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const scroll = vi.fn(async () => true);
    const target = { handle: 99, pid: 1, rect: [0, 0, 1280, 900] as [number, number, number, number] };
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: { scroll } as unknown as SnapshotHelper, windows: [target], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    session.startLive(owner, owner.mainFrame, session.token, 'scroll', { x: 100, y: 100, width: 400, height: 300 });
    expect(session.autoScroll(owner, owner.mainFrame, 'stale', true)).toBe(false);
    expect(session.autoScroll(owner, {} as Electron.WebFrameMain, session.token, true)).toBe(false);
    expect(session.autoScroll(owner, owner.mainFrame, session.token, true)).toBe(true);
    mocks.liveCapture.mockResolvedValueOnce(bitmap);
    expect((await session.liveFrame(owner, owner.mainFrame, session.token, false))?.autoScrolling).toBe(true);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(target, 300, 250, -60);
    await vi.advanceTimersByTimeAsync(200);
    let resolve!: (value: unknown) => void;
    mocks.liveCapture.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = session.liveFrame(owner, owner.mainFrame, session.token, false);
    session.holdCapture(owner, owner.mainFrame, session.token);
    resolve(bitmap);
    expect((await pending)?.autoScrolling).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(1);
    session.close();
    expect(session.autoScroll(owner, owner.mainFrame, session.token, true)).toBe(false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  it('keeps a finished recording available after a cancelled save and confines export to its chosen format', async () => {
    const largeDisplay = { ...display, bounds: { x: 0, y: 0, width: 1280, height: 900 }, scaleFactor: 1 };
    mocks.screen.getAllDisplays.mockReturnValue([largeDisplay]);
    const overlay = pool.ensure(largeDisplay)!;
    const owner = overlay.window.webContents;
    pool.markShellReady(owner, owner.mainFrame);
    const crop = { getSize: () => ({ width: 400, height: 300 }), toBitmap: () => Buffer.alloc(400 * 300 * 4), resize: () => crop };
    const source = { getSize: () => ({ width: 1280, height: 900 }), toBitmap: () => Buffer.alloc(1280 * 900 * 4), crop: () => crop } as unknown as NativeImage;
    const session = new RegionScreenshotSession({ pool, captures: [{ display: largeDisplay, image: source }], helper: {} as SnapshotHelper, windows: [], lastRegions: new Map(), onClosed: vi.fn(), onResult: vi.fn() });
    await session.open();
    session.painted(owner, owner.mainFrame, session.token);
    session.startLive(owner, owner.mainFrame, session.token, 'video', { x: 0, y: 0, width: 400, height: 300 });
    const clip = new Uint8Array(20); clip.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'gif')).toBe(false);
    expect(mocks.saveRecording).not.toHaveBeenCalled();
    mocks.saveRecording.mockResolvedValueOnce(false);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(false);
    expect(session.isClosed).toBe(false);
    expect(await session.saveRecording(owner, owner.mainFrame, session.token, clip, 'webm')).toBe(true);
    session.close();
  });

  it('prewarms without showing or transforming the macOS Dock identity, and reuses the shell', () => {
    pool.prewarm();
    pool.prewarm();
    expect(windows).toHaveLength(1);
    expect(windows[0].showInactive).not.toHaveBeenCalled();
    expect(windows[0].setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ skipTransformProcessType: true }),
    );
  });

  it('closes an unresponsive overlay and bounds repeated failures', () => {
    const gone = vi.fn();
    pool.setGoneHandler(gone);
    for (let i = 0; i < 4; i++) {
      pool.ensure(display);
      windows[i].emit('unresponsive');
      expect(windows[i].isDestroyed()).toBe(true);
    }
    expect(gone).toHaveBeenCalledTimes(4);
    expect(pool.ensure(display)).toBeNull();
  });

  it('accepts readiness only from the shell main frame and abandons unpainted screens', async () => {
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, {} as Electron.WebFrameMain);
    expect(overlay.shellReady).toBe(false);
    pool.markShellReady(contents, contents.mainFrame);
    const closed = vi.fn();
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: closed,
      onResult: vi.fn(),
    });
    await session.open();
    expect(windows[0].setOpacity).not.toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.isClosed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(windows[0].isVisible()).toBe(false);
  });

  it('keeps screenshots on workArea changes but closes on scale changes', async () => {
    const overlay = pool.ensure(display)!;
    pool.markShellReady(overlay.window.webContents, overlay.window.webContents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: vi.fn(),
    });
    await session.open();
    const change = mocks.screen.on.mock.calls.find(
      ([name]) => name === 'display-metrics-changed',
    )![1];
    change({}, display, ['workArea']);
    expect(session.isClosed).toBe(false);
    change({}, display, ['scaleFactor']);
    expect(session.isClosed).toBe(true);
  });

  it('sends pin pixel dimensions matching an exported 2x screenshot and only displays after painting', async () => {
    registerPinIpc();
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, contents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: ({ image: result }) => openPin(result, { x: 0, y: 0, width: 2, height: 2 }),
    });
    await session.open();
    expect(
      session.export(contents, contents.mainFrame, session.token, {
        action: 'pin',
        selection: { x: 0, y: 0, width: 2, height: 2 },
        image: { width: 4, height: 4, data: new Uint8Array(64) },
      }),
    ).toBe(true);
    const window = windows[1];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    mocks.handlers.get(P.SHELL_READY)!(event);
    const init = window.webContents.send.mock.calls.find(([name]) => name === P.INIT)![1];
    expect(init.image.width * init.image.height * 4).toBe(init.image.data.byteLength);
    expect(window.isVisible()).toBe(false);
    mocks.handlers.get(P.PAINTED)!(event);
    expect(window.isVisible()).toBe(true);
  });

  it('destroys a pin that never paints instead of showing a black window', async () => {
    openPin(image, { x: 0, y: 0, width: 2, height: 2 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(windows[0].isDestroyed()).toBe(true);
    expect(windows[0].showInactive).not.toHaveBeenCalled();
  });

  it('shares Escape without unregistering voice cancellation when a screenshot closes', () => {
    const voice = vi.fn();
    const releaseVoice = acquireOverlayEscape(voice)!;
    const screenshot = vi.fn(() => releaseScreenshot());
    const releaseScreenshot = acquireOverlayEscape(screenshot, 10)!;
    const escape = mocks.register.mock.calls[0][1] as () => void;
    escape();
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(voice).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
    escape();
    expect(voice).toHaveBeenCalledTimes(1);
    releaseVoice();
    releaseScreenshot();
    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('contains synchronous window creation failures during prewarm', () => {
    mocks.create.mockImplementation(() => {
      throw new Error('window unavailable');
    });
    expect(() => pool.prewarm()).not.toThrow();
    expect(pool.ensure(display)).toBeNull();
  });

  it('forwards Escape to the focused editor without handing it to voice input', async () => {
    const voice = vi.fn();
    const releaseVoice = acquireOverlayEscape(voice)!;
    const overlay = pool.ensure(display)!;
    const contents = overlay.window.webContents;
    pool.markShellReady(contents, contents.mainFrame);
    const session = new RegionScreenshotSession({
      pool,
      captures: [{ display, image }],
      helper: {} as SnapshotHelper,
      windows: [],
      lastRegions: new Map(),
      onClosed: vi.fn(),
      onResult: vi.fn(),
    });
    await session.open();
    windows[0].isFocused.mockReturnValue(true);
    session.focused(contents, contents.mainFrame, session.token);
    const escape = mocks.register.mock.calls[0][1];
    escape();
    expect(windows[0].webContents.sendInputEvent).toHaveBeenCalledWith({
      type: 'keyDown',
      keyCode: 'Escape',
    });
    expect(session.isClosed).toBe(false);
    expect(voice).not.toHaveBeenCalled();
    session.close();
    escape();
    expect(voice).toHaveBeenCalledTimes(1);
    releaseVoice();
  });
});
