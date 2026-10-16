import { useEffect, useRef } from 'react';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { NewSessionCreationTask } from './newSessionCreation';
import { returnNewSessionToEdit } from './returnNewSessionToEdit';

type RecoveryOptions = Parameters<typeof returnNewSessionToEdit>[0];

/** A failed creation has one next step: restore its draft in the new-task form. */
export function useFailedCreationReturnToEdit({ task, focused, connectionEpoch, stashDraft, onReady, onError }: {
  task: NewSessionCreationTask | null;
  focused: boolean;
  connectionEpoch: number;
  stashDraft: RecoveryOptions['stashDraft'];
  onReady: RecoveryOptions['onReady'];
  onError: (error: unknown) => void;
}) {
  const callbacks = useRef({ stashDraft, onReady, onError });
  callbacks.current = { stashDraft, onReady, onError };
  const navigated = useRef<string | null>(null);
  const sessionId = task?.sessionId;
  const deviceId = task?.deviceId;
  const failed = task?.status === 'create-failed';
  const startedAt = task?.startedAt;
  const readyForEdit = task?.readyForEdit;
  const current = useRef({ sessionId, deviceId, startedAt, focused });
  current.current = { sessionId, deviceId, startedAt, focused };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!failed || !focused || !sessionId || !deviceId) return;
    const identity = JSON.stringify([deviceId, sessionId, startedAt]);
    if (navigated.current === identity) return;
    const owner = getMobileAuthOwner();
    const isCurrent = () => mounted.current && current.current.focused
      && current.current.sessionId === sessionId && current.current.deviceId === deviceId
      && current.current.startedAt === startedAt && isMobileAuthOwnerCurrent(owner);
    void returnNewSessionToEdit({
      sessionId, deviceId, isCurrent,
      stashDraft: callbacks.current.stashDraft,
      onReady: params => {
        if (!isCurrent() || navigated.current === identity) return;
        navigated.current = identity;
        callbacks.current.onReady(params);
      },
    }).catch(error => {
      if (isCurrent()) callbacks.current.onError(error);
    });
    // Recovery itself continues after leaving. Re-entry (or restored connection)
    // can resume the existing recovery; ordinary store updates never retry it.
  }, [sessionId, deviceId, failed, startedAt, focused, connectionEpoch, readyForEdit]);
}
