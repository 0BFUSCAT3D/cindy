import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { remoteSessionStore } from './remoteSessionStore';
import { goBackGuarded } from '@/utils/backGuard';

/** Follow-ups use the ordinary task page. Keep deletion handling independent of
 * presentation, without introducing a second message host or keyboard layout. */
export function SideChatTaskBoundary({ children, deviceId, sessionId, enabled }: {
  children: ReactNode;
  deviceId: string;
  sessionId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const focused = useIsFocused();
  const scope = JSON.stringify([deviceId, sessionId]);
  const [removal, setRemoval] = useState({ scope, removed: false });
  // Reset only deletion state when params change. Keying this boundary by task
  // would also remount the page, its sidebar header and its measuring slot.
  if (removal.scope !== scope) setRemoval({ scope, removed: false });
  const removed = removal.scope === scope && removal.removed;
  const returned = useRef<typeof removal | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const unsubscribe = remoteSessionStore.onSessionRemoved((ownerDeviceId, removedSessionId) => {
      if (!active || ownerDeviceId !== deviceId || removedSessionId !== sessionId) return;
      setRemoval(current => current.scope === scope && !current.removed
        ? { scope, removed: true } : current);
    });
    return () => { active = false; unsubscribe(); };
  }, [deviceId, enabled, scope, sessionId]);
  useEffect(() => {
    // A hidden route waits for focus so deletion never pops a different screen.
    if (!focused || !removed || returned.current === removal) return;
    returned.current = removal;
    Keyboard.dismiss();
    goBackGuarded(router);
  }, [focused, removal, removed, router]);
  return removed ? null : children;
}
