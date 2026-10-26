import type { NativeImage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  ingest: vi.fn(),
  main: { isDestroyed: () => false, webContents: { mainFrame: {} } },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown) => unknown) => mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../../cindy-media/chatAttachments', () => ({ ingestChatImageBuffer: mocks.ingest }));
vi.mock('../../deepLink', () => ({
  focusMainWindow: vi.fn(),
  sendMainWindowMessage: vi.fn(),
  getDeepLinkMainWindow: () => mocks.main,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn() }) }));
import { handOffScreenshotToTask, registerScreenshotComposeIpc } from '../compose';
import { REGION_SCREENSHOT_COMPOSE_CHANNEL as C } from '../../../shared/regionScreenshot';

// 测试价值：真实 handOff/TAKE 入口不补发过期动作，不接受其他窗口，异步入库不颠倒动作顺序。
// 原来只有 renderer bus 覆盖；最小失败为等待 30s 后 TAKE，以及两次入库逆序完成。
// tier: unit，存储与窗口用内存 fake。
describe('screenshot compose delivery', () => {
  const image = {
    toPNG: () => Buffer.alloc(16),
    getSize: () => ({ width: 2, height: 2 }),
  } as NativeImage;
  const event = { sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame };
  const take = () => mocks.handlers.get(C.TAKE)!(event);
  beforeEach(() => {
    vi.useFakeTimers();
    registerScreenshotComposeIpc();
    mocks.ingest.mockResolvedValue({ url: 'media:a', filename: 'a.png' });
  });
  afterEach(() => {
    take();
    vi.useRealTimers();
  });
  it('does not replay an automatic action when the main window opens much later', async () => {
    await handOffScreenshotToTask(image, 'translate');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(take()).toBeNull();
  });
  it('only lets the main frame take a request once', async () => {
    await handOffScreenshotToTask(image, 'ask');
    expect(mocks.handlers.get(C.TAKE)!({ ...event, senderFrame: {} })).toBeNull();
    expect(take()).toMatchObject({ action: 'ask', url: 'media:a' });
    expect(take()).toBeNull();
  });
  it('keeps the latest action when an older media write completes last', async () => {
    let resolve!: (value: { url: string; filename: string }) => void;
    mocks.ingest.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = handOffScreenshotToTask(image, 'translate');
    await handOffScreenshotToTask(image, 'explain');
    resolve({ url: 'media:old', filename: 'old.png' });
    await first;
    expect(take()).toMatchObject({ action: 'explain', url: 'media:a' });
  });
});
