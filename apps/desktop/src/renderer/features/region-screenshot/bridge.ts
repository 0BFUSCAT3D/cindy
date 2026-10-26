import type {
  RegionRect,
  RegionScreenshotBegin,
  RegionScreenshotBitmap,
  RegionScreenshotExport,
  RegionScreenshotPinCommand,
  RegionScreenshotPinInit,
  RegionScreenshotPinState,
} from '../../../shared/regionScreenshot';
import type { RegionCaptureBegin, RegionCaptureFrame, RegionCaptureMode } from '../../../shared/regionCapture';

/** 框选浮层 preload (regionScreenshotPreload) 暴露的能力。 */
export interface RegionScreenshotOverlayBridge {
  autoScroll(token: string, enabled: boolean): Promise<boolean>;
  restoreEditor(token: string): Promise<boolean>;
  holdCapture(token: string): Promise<void>;
  startLive(token: string, mode: RegionCaptureMode, selection: RegionRect): Promise<RegionCaptureBegin | null>;
  liveFrame(token: string, keys: boolean, previewHeight?: number): Promise<RegionCaptureFrame | null>;
  saveRecording(token: string, bytes: Uint8Array, format: 'webm' | 'gif'): Promise<boolean>;
  shellReady(): void;
  onBegin(callback: (payload: RegionScreenshotBegin) => void): () => void;
  onEnd(callback: () => void): () => void;
  onClear(callback: () => void): () => void;
  painted(token: string): void;
  focused(token: string): void;
  selectionStarted(token: string): void;
  copyText(token: string, text: string): void;
  cancel(token: string): void;
  abandon(): void;
  elementsAt(token: string, windowId: number, x: number, y: number): Promise<RegionRect[]>;
  exportImage(token: string, payload: RegionScreenshotExport): Promise<boolean>;
}

/** 贴图 preload (regionScreenshotPinPreload) 暴露的能力。 */
export interface RegionScreenshotPinBridge {
  shellReady(): void;
  onInit(callback: (payload: RegionScreenshotPinInit) => void): () => void;
  onState(callback: (state: RegionScreenshotPinState) => void): () => void;
  painted(): void;
  dragStart(): void;
  dragMove(): void;
  zoom(steps: number, x: number, y: number): void;
  opacity(steps: number): void;
  menu(): void;
  command(command: RegionScreenshotPinCommand): void;
  unlockHover(hovering: boolean): void;
}

declare global {
  interface Window {
    regionScreenshot?: RegionScreenshotOverlayBridge;
    regionScreenshotPin?: RegionScreenshotPinBridge;
  }
}

/** BGRA → RGBA. A caller-owned destination may be reused; source stays immutable. */
export function bitmapToImageData(bitmap: RegionScreenshotBitmap, reuse?: ImageData): ImageData {
  const source = bitmap.data;
  const image = reuse?.width === bitmap.width && reuse.height === bitmap.height
    ? reuse
    : new ImageData(bitmap.width, bitmap.height);
  const rgba = image.data;
  for (let i = 0; i < source.length; i += 4) {
    rgba[i] = source[i + 2];
    rgba[i + 1] = source[i + 1];
    rgba[i + 2] = source[i];
    rgba[i + 3] = source[i + 3];
  }
  return image;
}

/** 画布像素 (RGBA) → Electron 位图 (BGRA), 原地交换后复用同一块内存。 */
export function imageDataToBitmap(image: ImageData): RegionScreenshotBitmap {
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i];
    data[i] = data[i + 2];
    data[i + 2] = red;
  }
  return { width: image.width, height: image.height, data: data as Uint8Array<ArrayBuffer> };
}
