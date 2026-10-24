import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { appendedMessageKeys } from '@cindy/maker-shared/message-presentation';
import { Animated, Easing } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme';

/** Only live tail additions animate; creation time does not tell us when a reply was revealed. */
export function useMessageEntrances(keys: readonly string[], scope: string | undefined, ready = true) {
  const previous = useRef<{ scope: string | undefined; keys: readonly string[] } | null>(null);
  const arriving = useMemo(() => {
    const added = ready ? appendedMessageKeys(previous.current && previous.current.scope === scope ? previous.current.keys : undefined, keys) : [];
    const now = Date.now();
    return new Map([...added].map(key => [key, now]));
  }, [keys, scope, ready]);
  useLayoutEffect(() => { previous.current = ready ? { scope, keys } : null; }, [keys, scope, ready]);
  return arriving;
}

/** A recycled or acknowledged message must not replay its entrance. */
const MAX_REMEMBERED = 200;
const animated = new Set<string>();

/**
 * One-shot entrance: fades in while rising `distance` pt (and growing from `scaleFrom`), ease-out.
 * Transform and opacity only, native driver; renders children as-is when `play` is false or the
 * system asks for reduced motion.
 */
export function CompanionFadeIn({ play, distance, scaleFrom, duration = motionDuration.base, delay = 0, children }: {
  play: boolean; distance: number; scaleFrom?: number; duration?: number; delay?: number; children: ReactNode;
}) {
  const reduceMotion = useReduceMotionEnabled();
  const run = useRef<boolean | null>(null);
  if (run.current === null) run.current = play && reduceMotion === false;
  const progress = useRef(new Animated.Value(run.current ? 0 : 1)).current;
  useEffect(() => {
    if (!run.current || reduceMotion !== false) { progress.setValue(1); return; }
    const timing = Animated.timing(progress, {
      toValue: 1, duration, delay, easing: Easing.bezier(...motionEasing.out), useNativeDriver: true,
    });
    timing.start();
    return () => timing.stop();
  }, [delay, duration, progress, reduceMotion]);
  if (!run.current) return <>{children}</>;
  const transform = [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
    ...(scaleFrom !== undefined ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [scaleFrom, 1] }) }] : []),
  ];
  return <Animated.View style={{ opacity: progress, transform }}>{children}</Animated.View>;
}

/**
 * Entering motion for a companion conversation row (M4 / M5). Keyed by message: a row animates at
 * most once, when it is appended to an already open timeline. History stays still and a slow
 * reply gets the same entrance as a fast one. Never scale text or change row layout.
 */
export function CompanionEntering({ id, arrivedAt, children }: {
  id: string; arrivedAt?: number; children: ReactNode;
}) {
  // Cells first mounted later by scrolling are history, even if their list projection is unchanged.
  const entering = arrivedAt !== undefined && Date.now() - arrivedAt < 1000;
  const reduceMotion = useReduceMotionEnabled();
  const progress = useRef(new Animated.Value(entering && !animated.has(id) && reduceMotion === false ? 0 : 1)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  useLayoutEffect(() => {
    if (!entering || animated.has(id)) return;
    animated.add(id);
    if (animated.size > MAX_REMEMBERED) animated.delete(animated.values().next().value!);
    if (reduceMotion !== false) { progress.setValue(1); return; }
    progress.setValue(0);
    animation.current = Animated.timing(progress, { toValue: 1, duration: motionDuration.base,
      easing: Easing.bezier(...motionEasing.out), useNativeDriver: true });
    animation.current.start();
  }, [entering, id, progress, reduceMotion]);
  useLayoutEffect(() => {
    if (reduceMotion !== false) { animation.current?.stop(); progress.setValue(1); }
    return () => { animation.current?.stop(); progress.setValue(1); };
  }, [id, progress, reduceMotion]);
  return <Animated.View style={{ opacity: progress, transform: [
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
  ] }}>
    {children}
  </Animated.View>;
}
