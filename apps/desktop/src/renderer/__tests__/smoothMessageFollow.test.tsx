/** @vitest-environment jsdom */
import { act, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSmoothMessageFollow } from '../components/chat/useSmoothMessageFollow';

// Regression (#7123/#7278): history arriving after two quiet frames was treated
// as live motion, and subsequent native navigation retargeted the whole column.
// Existing virtualizer tests do not exercise this follow hook. The minimal unit
// case is a settled list followed by a delayed height change, then navigation.
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

it('pins initial and delayed history corrections without moving the content layer', async () => {
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
  expect(animate).not.toHaveBeenCalled();
});

it('keeps repeated observer pins and subsequent growth instantaneous', async () => {
  await act(async () => root.render(<Fixture />));
  await frame();
  await act(async () => follow());
  await frame();
  await grow(2040);
  expect(animate).not.toHaveBeenCalled();
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
  expect(animate).not.toHaveBeenCalled();
});

it('restarts initial positioning after deactivation', async () => {
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2040);
  await act(async () => root.render(<Fixture active={false} />));
  animate.mockClear();
  await act(async () => root.render(<Fixture />));
  await grow(2600);
  expect(top).toBe(2000);
  expect(animate).not.toHaveBeenCalled();
});

it('leaves native scroll position unchanged when a user takes over', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(100);
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2040);
  await act(async () => host.firstElementChild!.dispatchEvent(new Event('wheel')));
  expect(top).toBe(1440);
  expect(animate).not.toHaveBeenCalled();
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

it('does not reinterpret programmatic navigation as a follow correction', async () => {
  await act(async () => root.render(<Fixture />));
  await settle();
  await grow(2452);
  top = 500;
  await act(async () => host.firstElementChild!.dispatchEvent(new Event('scroll')));
  expect(top).toBe(500);
  expect(animate).not.toHaveBeenCalled();
});

it('does not pin a deactivated stream', async () => {
  await act(async () => root.render(<Fixture active={false} />));
  await grow(2452);
  expect(top).toBe(0);
  expect(animate).not.toHaveBeenCalled();
});
