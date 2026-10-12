import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { deleteSecureItem } from '@/auth/secureStorage';

/*
 * Storage keys of "recognize my voice", kept apart from the service so sign-out
 * can clear them without loading the file system or the native module.
 */

const PREFS_PREFIX = 'cindy.mobile.voice-speaker-filter.v1.';
// SecureStore keys only allow [A-Za-z0-9._-]; the account key is hashed.
const PROFILE_PREFIX = 'xdt.voiceSpeakerProfile.v1.';
const pending = new Map<string, Promise<unknown>>();

/** Keep deletion (including sign-out) after writes already in flight. */
export function serializeSpeakerFilterStorage<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
  const run = (pending.get(accountKey) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(accountKey, run);
  const clear = () => {
    if (pending.get(accountKey) === run) pending.delete(accountKey);
  };
  void run.then(clear, clear);
  return run;
}

export function speakerFilterPrefsKey(accountKey: string): string {
  return PREFS_PREFIX + accountKey;
}

export function speakerProfileKey(accountKey: string): string {
  return PROFILE_PREFIX + bytesToHex(sha256(utf8ToBytes(accountKey))).slice(0, 32);
}

/**
 * Sign-out cleanup: the voiceprint and its settings are this account's
 * biometric data and leave with its other local data. The account-free
 * model files stay. The in-memory copy resets itself when the owner clears.
 */
export async function clearMobileSpeakerFilterForAccount(accountKey: string): Promise<void> {
  if (!accountKey) return;
  await serializeSpeakerFilterStorage(accountKey, async () => {
    await Promise.all([
      deleteSecureItem(speakerProfileKey(accountKey)).catch(() => undefined),
      AsyncStorage.removeItem(speakerFilterPrefsKey(accountKey)).catch(() => undefined),
    ]);
  });
}
