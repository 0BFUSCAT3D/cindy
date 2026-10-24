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
  error: string | null;
  toggle: () => void;
  stop: () => Promise<string | null>;
} {
  const auth = useAskCardAuth();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<VoiceRun | null>(null);
  const startingRef = useRef(false);
  const startingPromiseRef = useRef<Promise<void> | null>(null);
  const stoppingRef = useRef<Promise<string | null> | null>(null);
  const startAbortRef = useRef<AbortController | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const authRef = useRef(auth);
  authRef.current = auth;

  const stop = useCallback((waitForStartup = true) => {
    if (stoppingRef.current) return stoppingRef.current;
    const wasStarting = startingRef.current;
    const pendingStart = wasStarting ? startingPromiseRef.current : null;
    // Send preserves captured audio while connecting. A second microphone tap
    // still cancels startup immediately, as does removing the card.
    if (!waitForStartup) {
      startingRef.current = false;
      startAbortRef.current?.abort();
      startAbortRef.current = null;
    }
    if (!runRef.current && (!waitForStartup || !pendingStart)) {
      setListening(false);
      return Promise.resolve(wasStarting ? null : inputRef.current.getText());
    }
    // Keep the run owned until final ASR/refinement settles. Unmount can then
    // cancel it, and another Send joins this same stop instead of using a draft.
    const stopping = (async () => {
      if (pendingStart) await pendingStart;
      const run = runRef.current;
      if (!run) return null;
      try {
        await run.stop();
        return runRef.current === run ? inputRef.current.getText() : null;
      } finally {
        if (runRef.current === run) runRef.current = null;
      }
    })().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
      return null;
    }).finally(() => {
      setListening(false);
      if (stoppingRef.current === stopping) stoppingRef.current = null;
    });
    stoppingRef.current = stopping;
    return stopping;
  }, []);

  // The card unmounts when the answer is submitted, skipped or the request
  // disappears — the recording must not outlive it.
  useEffect(() => () => {
    startingRef.current = false;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    const run = runRef.current;
    runRef.current = null;
    void run?.cancel().catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    // A session that is still closing must finish first; starting a new one
    // now would race the microphone teardown.
    if (stoppingRef.current) return;
    if (runRef.current || startingRef.current) {
      void stop(false);
      return;
    }
    const deviceId = inputRef.current.deviceId?.trim();
    const currentAuth = authRef.current;
    if (!deviceId || !currentAuth) {
      setError(i18n.t('composer.voice.loginRequired'));
      return;
    }
    startingRef.current = true;
    // The answer belongs to this take from the initial tap, including startup
    // before the first PCM chunk. Keep edits/navigation frozen until it settles.
    setListening(true);
    setError(null);
    const abort = new AbortController();
    startAbortRef.current = abort;
    const starting = (async () => {
      try {
        const { startAskCardDictation } = await import('@/session/askCardVoiceStart');
        if (abort.signal.aborted || !startingRef.current) return;
        const run = await startAskCardDictation({
          deviceId,
          signal: abort.signal,
          getAccessToken: () => currentAuth.getAccessToken(),
          refreshAccessToken: () => currentAuth.refreshAccessToken(),
          apiFetch: currentAuth.apiFetch,
          getText: () => inputRef.current.getText(),
          setText: (value) => {
            if (!abort.signal.aborted) inputRef.current.setText(value);
          },
          getSelection: () => inputRef.current.getSelection(),
          onListening: () => {
            if (!abort.signal.aborted && (startingRef.current || runRef.current)) setListening(true);
          },
          onError: (message) => {
            if (abort.signal.aborted) return;
            startingRef.current = false;
            runRef.current = null;
            setListening(false);
            setError(message);
          },
        });
        if (abort.signal.aborted || !startingRef.current) {
          await run.cancel();
          return;
        }
        runRef.current = run;
        startingRef.current = false;
        setListening(true);
      } catch (error) {
        if (abort.signal.aborted) return;
        startingRef.current = false;
        setListening(false);
        // Stopping during startup is a normal outcome, not a failure.
        if (!(error instanceof Error && error.name === 'AskCardVoiceCancelledError')) {
          setError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (startAbortRef.current === abort) startAbortRef.current = null;
      }
    })().finally(() => {
      if (startingPromiseRef.current === starting) startingPromiseRef.current = null;
    });
    startingPromiseRef.current = starting;
  }, [stop]);

  return { listening, error, toggle, stop };
}
