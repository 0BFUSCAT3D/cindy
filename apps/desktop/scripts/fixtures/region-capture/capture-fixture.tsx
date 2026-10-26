import { mountPage } from '../../ui-page/harness';
import { LiveCapturePanel } from '../../../src/renderer/features/region-screenshot/LiveCapturePanel';
import { RegionScreenshotOverlay } from '../../../src/renderer/features/region-screenshot/RegionScreenshotOverlay';
import { imageDataToBitmap, type RegionScreenshotOverlayBridge } from '../../../src/renderer/features/region-screenshot/bridge';
import { scrollCaptureLayout, type RegionCaptureMode } from '../../../src/shared/regionCapture';

const qa = { frames: 0, scrollFrames: 0, scrollLimit: 180, idle: false, automatic: false, saved: null as Uint8Array | null, format: '', exportedHeight: 0, annotationPixels: 0, restored: false };
Object.assign(window, { captureQa: qa });

function frame(scroll = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 240;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f8f8f6'; context.fillRect(0, 0, 480, 240);
  context.font = '16px sans-serif';
  for (let row = 0; row < 30; row++) {
    const y = row * 30 - scroll;
    context.fillStyle = row % 2 ? '#dddddd' : '#ffffff'; context.fillRect(0, y, 480, 30);
    context.fillStyle = '#262626'; context.fillText(`${String(row + 1).padStart(2, '0')}  Cindy capture — ${row * 7919}   ${row * 541}   ${row * 1237}`, 12, y + 21);
  }
  return imageDataToBitmap(context.getImageData(0, 0, 480, 240));
}

mountPage({
  render: (ctx) => {
    const mode = (['default', 'idle', 'inactive', 'drag'].includes(ctx.case) ? 'scroll' : ctx.case) as RegionCaptureMode;
    qa.idle = ctx.case === 'idle';
    let begin: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0] | undefined;
    const bridge: RegionScreenshotOverlayBridge = {
      autoScroll: async (_token, enabled) => { qa.automatic = enabled; return true; },
      shellReady() { queueMicrotask(() => begin?.({ token: 'fixture', locale: ctx.locale, viewport: { width: innerWidth, height: innerHeight }, scaleFactor: 1, frame: frame(), windows: [], lastRegion: null, cursor: ctx.case === 'inactive' ? null : { x: 0, y: 0 } })); },
      onBegin: (callback) => { begin = callback; return () => { begin = undefined; }; }, onEnd: () => () => {}, onClear: () => () => {},
      painted() {}, focused() {}, selectionStarted() {}, copyText() {}, cancel() {}, abandon() {},
      elementsAt: async () => [], startLive: async (_token, captureMode, selection) => ({ mode: captureMode, selection, first: frame(), scrollLayout: scrollCaptureLayout(selection, { width: innerWidth, height: innerHeight })! }),
      restoreEditor: async () => { qa.restored = true; return true; },
      holdCapture: async () => {},
      liveFrame: async () => {
        qa.frames++;
        if (!qa.idle) qa.scrollFrames++;
        const image = frame(mode === 'scroll' ? Math.min(qa.scrollLimit, qa.scrollFrames * 30) : qa.frames % 10);
        // A source window repaints after the frozen selection, before any scroll.
        // Deliberately larger than a caret so this also exercises unmatched startup.
        if (qa.idle) image.data.fill(255, 480 * 4 * 60, 480 * 4 * 140);
        return { image, autoScrolling: qa.automatic, cursor: { x: 100 + qa.frames, y: 80 }, keys: ['Ctrl', 'C'] };
      },
      saveRecording: async (_token, bytes, format) => { qa.saved = bytes; qa.format = format; return true; },
      exportImage: async (_token, payload) => {
        qa.exportedHeight = payload.image.height;
        for (let i = 0; i < payload.image.data.length; i += 4) if (payload.image.data[i + 2] > 180 && payload.image.data[i] < 100) qa.annotationPixels++;
        return true;
      },
    };
    if (mode === 'scroll') return <RegionScreenshotOverlay bridge={bridge} />;
    return <LiveCapturePanel token="fixture" bridge={bridge} begin={{ mode, selection: { x: 0, y: 0, width: 480, height: 240 }, first: frame() }} />;
  },
});
