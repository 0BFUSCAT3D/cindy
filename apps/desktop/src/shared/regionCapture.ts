import type { RegionPoint, RegionRect, RegionScreenshotBitmap } from './regionScreenshot';

export type RegionCaptureMode = 'scroll' | 'video' | 'gif';
export interface RegionCaptureBegin {
  mode: RegionCaptureMode;
  selection: RegionRect;
  first: RegionScreenshotBitmap;
  scrollLayout?: ScrollCaptureLayout;
}
export interface RegionCaptureFrame {
  image: RegionScreenshotBitmap;
  cursor: RegionPoint | null;
  keys: string[] | null;
  autoScrolling?: boolean;
}
export interface ScrollCaptureLayout {
  viewport: { width: number; height: number };
  preview: RegionRect;
  auto: RegionRect;
}
export const REGION_CAPTURE_CHANNEL = {
  START: 'region-screenshot:live-start',
  FRAME: 'region-screenshot:live-frame',
  SAVE: 'region-screenshot:live-save',
  EDIT: 'region-screenshot:live-edit',
  HOLD: 'region-screenshot:live-hold',
  AUTO_SCROLL: 'region-screenshot:auto-scroll',
} as const;
export const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
export const MAX_RECORDING_MS = 5 * 60_000;

/** The preview/actions belong to the selection and never cover source pixels. */
export function scrollCaptureLayout(selection: RegionRect, viewport: { width: number; height: number }): ScrollCaptureLayout | null {
  const gap = 12, minimumWidth = 208, preferredWidth = Math.min(640, Math.max(400, selection.width * 0.6)), footer = 40;
  const right = selection.x + selection.width;
  const bottom = selection.y + selection.height;
  const rightSpace = viewport.width - right - gap - 8;
  const leftSpace = selection.x - gap - 8;
  const useRight = rightSpace >= minimumWidth && (rightSpace >= preferredWidth || rightSpace >= leftSpace);
  const sideSpace = useRight ? rightSpace : leftSpace;
  const width = Math.min(preferredWidth, sideSpace >= minimumWidth ? sideSpace : preferredWidth);
  const sideX = sideSpace >= minimumWidth ? (useRight ? right + gap : selection.x - width - gap) : null;
  const below = viewport.height - bottom >= 52;
  const above = selection.y >= 52;
  if (!below && !above) return null;
  const auto = { x: Math.max(0, Math.min(viewport.width - 132, selection.x + (selection.width - 132) / 2)), y: below ? bottom + 8 : selection.y - 40, width: 132, height: 32 };
  if (sideX !== null) {
    const height = Math.min(viewport.height - 32, Math.max(480, selection.height + 64));
    return { viewport, auto, preview: { x: sideX, y: Math.max(8, Math.min(selection.y, viewport.height - height - 8)), width, height } };
  }
  // Wide selections place the thumbnail above/below, still on this display.
  const available = below ? viewport.height - bottom - 16 : selection.y - 16;
  const previewHeight = Math.min(220, available);
  if (previewHeight < footer + 48) return null;
  const preview = { x: Math.max(8, Math.min(viewport.width - width - 8, right - width)), y: below ? bottom + 8 : selection.y - previewHeight - 8, width, height: previewHeight };
  auto.x = Math.max(8, preview.x - auto.width - gap);
  if (auto.x + auto.width > preview.x - gap) return null;
  return { viewport, auto, preview };
}

/** Choose a panel position wholly outside the capture, including on a second monitor. */
export function capturePanelBounds(selection: RegionRect, displays: readonly RegionRect[], compact = false): RegionRect | null {
  for (const display of displays) {
    const right = display.x + display.width;
    const bottom = display.y + display.height;
    const intersects = selection.x < right && selection.x + selection.width > display.x && selection.y < bottom && selection.y + selection.height > display.y;
    const spaces = intersects ? [
      { x: display.x, y: selection.y + selection.height, width: display.width, height: bottom - selection.y - selection.height },
      { x: display.x, y: display.y, width: display.width, height: selection.y - display.y },
      { x: display.x, y: display.y, width: selection.x - display.x, height: display.height },
      { x: selection.x + selection.width, y: display.y, width: right - selection.x - selection.width, height: display.height },
    ] : [display];
    for (const space of spaces) {
      if (space.width < (compact ? 420 : 336) || space.height < (compact ? 88 : 244)) continue;
      const width = Math.min(compact ? 600 : 440, space.width - 16);
      const height = Math.min(compact ? 72 : 320, space.height - 16);
      const x = Math.max(space.x + 8, Math.min(selection.x + selection.width - width, space.x + space.width - width - 8));
      const y = space.y >= selection.y + selection.height ? space.y + 8 : Math.max(space.y + 8, space.y + space.height - height - 8);
      return { x: Math.round(x), y: Math.round(y), width: Math.floor(width), height: Math.floor(height) };
    }
  }
  return null;
}

/** Only fixed-format clip bytes cross the export bridge; paths never do. */
export function validRecordingBytes(raw: unknown, format: unknown): raw is Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.length < 16 || raw.length > MAX_RECORDING_BYTES) return false;
  if (format === 'gif') return String.fromCharCode(...raw.subarray(0, 6)) === 'GIF89a' && raw[raw.length - 1] === 0x3b;
  return format === 'webm' && raw[0] === 0x1a && raw[1] === 0x45 && raw[2] === 0xdf && raw[3] === 0xa3;
}
