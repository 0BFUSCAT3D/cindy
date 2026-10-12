import { useSyncExternalStore, type ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { remoteSessionStore } from './remoteSessionStore';

/** Use the raw mirror to recognize hidden tasks opened by an old link. */
export function CindyMakeSessionGate({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const hidden = useSyncExternalStore(remoteSessionStore.subscribe, () =>
    !CINDY_MAKE_ENABLED && isCindyMakeSource(
      remoteSessionStore.getSessions().find(session => session.id === sessionId)?.source,
    ),
  );
  return hidden ? <Redirect href="/" /> : children;
}
