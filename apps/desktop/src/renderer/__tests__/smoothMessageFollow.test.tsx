/** @vitest-environment jsdom */
import { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSmoothMessageFollow } from '../components/chat/useSmoothMessageFollow';

// Regression: reopening a long running task animated its initial layout by 452px.
// The virtualizer tests do not mount the real follow hook. This unit fixture
// exercises repeated initial pins, later streaming and gesture/lifecycle takeover.
let host: HTMLDivElement;
let root: Root;
let follow: () => void;
let height: number;
let top: number;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let reduced: boolean;
const cancel = vi.fn();
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
  cancel,
  playState: 'running',
  startTime: 0,
}));

function Fixture({ active = true, loaded = true }: { active?: boolean; loaded?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  follow = useSmoothMessageFollow(scrollRef, contentRef, active);
  useLayoutEffect(() => {
    Object.defineProperties(scrollRef.current!, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 600 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - 600));
        },
      },
    });
    contentRef.current!.animate = animate as unknown as HTMLElement['animate'];
    follow();
  }, [active, loaded]);
  return (
    <div ref={scrollRef}>
      <div ref={contentRef}>{loaded ? 'Message' : null}</div>
    </div>
  );
}

async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach((callback) => callback(performance.now())));
}
async function settle() {
  await frame();
  await frame();
}
async function grow(value: number) {
  height = value;
  await act(async () => follow());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  sequence = 0;
  height = 2000;
  top = 0;
  reduced = false;
  animate.mockClear();
  cancel.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (key: string) =>
      key === '--motion-base' ? '200ms' : 'cubic-bezier(0.4, 0, 0.2, 1)',
  } as CSSStyleDeclaration);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('pins all initial layout corrections directly, then animates later content', async () => {
  await act(async () => root.render(<Fixture />));
  await grow(2452); // virtualized rows mount again before the first paint
  expect(top).toBe(1852);
  expect(animate).not.toHaveBeenCalled();
  await frame();
  await grow(2372); // ResizeObserver corrects the estimate after that frame
  await frame();
  await grow(2587);
  expect(top).toBe(1987);
  expect(animate).not.toHaveBeenCalled();
  await settle();
  await grow(2627);
  expect(top).toBe(2027);
  expect(animate.mock.calls.at(-1)?.[0]).toEqual([
    { transform: 'translateY(40px)' },
    { transform: 'translateY(0)' },
  ]);
});

it('does not starve settling when observers repeat an unchanged pin', async () => {
  await act(async () => root.render(<Fixture />));
  await frame();
  await act(async () => follow());
  await frame();
  await grow(2040);
  expect(animate).toHaveBeenCalledTimes(1);
});

it('keeps a delayed first history page in initial positioning', async () => {
  height = 600;
  await act(async () => root.render(<Fixture loaded={false} />));
  await settle();
  height = 2400;
  await act(async () => root.render(<Fixture />));
  await grow(2452);
  expect(top).toBe(1852);
  expect(animate).not.toHaveBeenCalled();
  await settle();
  await grow(2492);
  expect(animate).toHaveBeenCalledTimes(1);
});

it('restarts initial positioning after deactivation', async () => {
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2040);
  await act(async () => root.render(<Fixture active={false} />));
  expect(cancel).toHaveBeenCalled();
  animate.mockClear();
  await act(async () => root.render(<Fixture />));
  await grow(2600);
  expect(top).toBe(2000);
  expect(animate).not.toHaveBeenCalled();
});

it('hands the displayed offset to a user gesture without keeping an animation', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100);
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2040);
  await act(async () => host.firstElementChild!.dispatchEvent(new Event('wheel')));
  expect(top).toBeCloseTo(1400, 2);
  expect(cancel).toHaveBeenCalled();
});

it('keeps reduced motion instantaneous after initial positioning', async () => {
  reduced = true;
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2040);
  expect(top).toBe(1440);
  expect(animate).not.toHaveBeenCalled();
});

it('cancels pending initialization when the stream is deactivated', async () => {
  await act(async () => root.render(<Fixture />));
  await frame();
  await act(async () => root.render(<Fixture active={false} />));
  expect(frames.size).toBe(0);
});
