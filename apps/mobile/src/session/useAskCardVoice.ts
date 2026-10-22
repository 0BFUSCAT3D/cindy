/**
 * Voice input for the mobile question card's free-text answer.
 *
 * The composer owns the full press-and-hold path. This hook starts the same
 * dictation session against the answer string, and only loads the native audio
 * modules when the user actually taps the microphone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18n } from '@/i18n';
import { useAskCardAuth } from '@/session/askCardAuth';
import type { MobileVoiceSelection } from '@/session/mobileVoiceInput';

type VoiceRun = {
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
};

export function useAskCardVoice(input: {
  deviceId?: string;
  getText: () => string;
  setText: (value: string) => void;
  getSelection: () => MobileVoiceSelection;
}): {
  listening: boolean;
  stopping: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => Promise<boolean>;
} {
  const auth = useAskCardAuth();
  const [listening, setListening] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<VoiceRun | null>(null);
  const startingRef = useRef(false);
  const stoppingRef = useRef<Promise<boolean> | null>(null);
  const failedRef = useRef(false);
  const mountedRef = useRef(true);
  const startAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const authRef = useRef(auth);
  authRef.current = auth;

  const stop = useCallback(() => {
    if (stoppingRef.current) return stoppingRef.current;
    const run = runRef.current;
    const abort = startAbortRef.current;
    if (!run) {
      startingRef.current = false;
      abort?.abort();
      setListening(false);
      return Promise.resolve(false);
    }
    setStopping(true);
    const finishing = run.stop().then(() => !failedRef.current && !abort?.signal.aborted).catch((error: unknown) => {
      if (mountedRef.current) setError(error instanceof Error ? error.message : String(error));
      return false;
    }).finally(() => {
      if (runRef.current === run) runRef.current = null;
      if (stoppingRef.current === finishing) stoppingRef.current = null;
      startingRef.current = false;
      abort?.abort();
      if (mountedRef.current) {
        setListening(false);
        setStopping(false);
      }
    });
    stoppingRef.current = finishing;
    return finishing;
  }, []);

  // The card unmounts when the answer is submitted, skipped or the request
  // disappears — the recording must not outlive it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startingRef.current = false;
      startAbortRef.current?.abort();
      startAbortRef.current = null;
      const run = runRef.current;
      runRef.current = null;
      void run?.cancel().catch(() => undefined);
    };
  }, []);

  const toggle = useCallback(() => {
    // A session that is still closing must finish first; starting a new one
    // now would race the microphone teardown.
    if (stoppingRef.current) return;
    if (runRef.current || startingRef.current) {
      stop();
      return;
    }
    const deviceId = inputRef.current.deviceId?.trim();
    const currentAuth = authRef.current;
    if (!deviceId || !currentAuth) {
      setError(i18n.t('composer.voice.loginRequired'));
      return;
    }
    startingRef.current = true;
    failedRef.current = false;
    setListening(true);
    setError(null);
    const abort = new AbortController();
    startAbortRef.current = abort;
    void (async () => {
      try {
        const { startAskCardDictation } = await import('@/session/askCardVoiceStart');
        if (abort.signal.aborted) return;
        const run = await startAskCardDictation({
          deviceId,
          signal: abort.signal,
          getAccessToken: () => currentAuth.getAccessToken(),
          refreshAccessToken: () => currentAuth.refreshAccessToken(),
          apiFetch: currentAuth.apiFetch,
          getText: () => inputRef.current.getText(),
          setText: (value) => { if (!abort.signal.aborted) inputRef.current.setText(value); },
          getSelection: () => inputRef.current.getSelection(),
          onListening: () => {
            if (!abort.signal.aborted && !stoppingRef.current) setListening(true);
          },
          onRunCreated: (run) => { if (!abort.signal.aborted) runRef.current = run; },
          onError: (message) => {
            if (abort.signal.aborted) return;
            failedRef.current = true;
            startingRef.current = false;
            setError(message);
            if (!stoppingRef.current) {
              const failedRun = runRef.current;
              runRef.current = null;
              abort.abort();
              setListening(false);
              void failedRun?.cancel().catch(() => undefined);
            }
          },
        });
        if (abort.signal.aborted) {
          await run.cancel();
          return;
        }
        runRef.current = run;
        startingRef.current = false;
        if (!stoppingRef.current) setListening(true);
      } catch (error) {
        if (abort.signal.aborted) return;
        startingRef.current = false;
        runRef.current = null;
        setListening(false);
        // Stopping during startup is a normal outcome, not a failure.
        if (!(error instanceof Error && error.name === 'AskCardVoiceCancelledError')) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
  }, [stop]);

  return { listening, stopping, error, toggle, stop };
}
