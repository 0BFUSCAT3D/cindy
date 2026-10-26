import { useCallback, type RefObject } from 'react';

/**
 * Pin native scroll geometry only. Callers own whether the reader follows the tail.
 * A height change cannot distinguish live content from delayed history, virtualizer
 * measurements or disclosure. Translating the whole column here animated all of
 * those operations and competed with native navigation/anchor restoration.
 * Keep the existing entry point while removing that second scroll owner; local
 * row/disclosure transitions and explicit smooth navigation remain independent.
 */
export function useSmoothMessageFollow(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  active = true,
) {
  return useCallback(() => {
    const scroll = scrollRef.current;
    if (!active || !scroll || !contentRef.current) return;
    scroll.scrollTop = scroll.scrollHeight;
  }, [scrollRef, contentRef, active]);
}
