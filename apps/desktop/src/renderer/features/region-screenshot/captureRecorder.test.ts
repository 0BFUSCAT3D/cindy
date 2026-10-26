import { afterEach, expect, it, vi } from 'vitest';
import { CaptureRecorder } from './captureRecorder';

// Unit regression: the UI matrix produced an empty short WebM that was reported
// as saved. Exercise the encoder's real finish boundary with an empty browser
// stop event; geometry and browser playback tests do not cover this outcome.
afterEach(() => vi.unstubAllGlobals());

it('rejects a recording when the browser stops without encoded frames', async () => {
  class EmptyRecorder {
    static isTypeSupported() { return true; }
    state = 'recording';
    onstop: (() => void) | null = null;
    start() {}
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  vi.stubGlobal('MediaRecorder', EmptyRecorder);
  const track = { stop: vi.fn(), requestFrame: vi.fn() };
  const canvas = { captureStream: () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } as unknown as HTMLCanvasElement;
  const recorder = new CaptureRecorder(canvas, 'webm', () => {});
  recorder.add(0);
  await expect(recorder.finish(1)).rejects.toThrow('No video frames were encoded');
  expect(track.stop).toHaveBeenCalled();
});
