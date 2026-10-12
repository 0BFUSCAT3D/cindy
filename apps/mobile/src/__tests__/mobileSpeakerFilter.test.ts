import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSpeakerEnrollment, SPEAKER_MODEL_ASSETS, SpeakerGate, speakerModelAsset, speakerModelLocalName } from '@cindy/voice-input-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { loadSpeakerModels, nativeSpeakerOnnxRunner } from '../../modules/cindy-speaker-onnx/src';

vi.mock('@cindy/voice-input-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/voice-input-core')>();
  return { ...actual, buildSpeakerEnrollment: vi.fn(actual.buildSpeakerEnrollment) };
});

const asyncStore = new Map<string, string>();
const secureStore = new Map<string, string>();
const files = new Map<string, number>();
const sha = { value: '' };

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStore.delete(key);
    }),
  },
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureStore.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureStore.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureStore.delete(key);
  }),
}));
vi.mock('@/config/env', () => ({ ENDPOINT_MANIFEST_BASE_URL: 'https://cdn.example.com' }));
vi.mock('@/session/mobileVoiceDiagnostics', () => ({ logMobileVoice: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: vi.fn(async (path: string) =>
    files.has(path) ? { exists: true, isDirectory: false, size: files.get(path) } : { exists: false }),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => [...files.keys()].map((path) => path.slice('file:///cache/voice-models/'.length))),
  deleteAsync: vi.fn(async (path: string) => {
    files.delete(path);
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    files.set(to, files.get(from) ?? 0);
    files.delete(from);
  }),
  createDownloadResumable: vi.fn((url: string, target: string) => ({
    downloadAsync: async () => {
      const asset = SPEAKER_MODEL_ASSETS.find((candidate) => url.includes(candidate.sha256))!;
      files.set(target, asset.bytes);
      return { status: 200, uri: target };
    },
    cancelAsync: async () => undefined,
  })),
}));
vi.mock('../../modules/cindy-speaker-onnx/src', () => ({
  isSpeakerOnnxAvailable: () => true,
  loadSpeakerModels: vi.fn(async () => undefined),
  sha256File: vi.fn(async (path: string) => {
    if (sha.value) return sha.value;
    return SPEAKER_MODEL_ASSETS.find((asset) => path.includes(speakerModelLocalName(asset)))!.sha256;
  }),
  nativeSpeakerOnnxRunner: { run: vi.fn() },
}));

const { setMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
const service = await import('@/session/mobileSpeakerFilter');

function installModels(): void {
  for (const asset of SPEAKER_MODEL_ASSETS) {
    files.set(`file:///cache/voice-models/${speakerModelLocalName(asset)}`, asset.bytes);
  }
}

function storeProfile(accountKey: string, modelSha256 = speakerModelAsset('embedding').sha256): void {
  const bytes = new Uint8Array(Float32Array.of(0.6, 0.8).buffer);
  secureStore.set(
    service.__testing.profileKey(accountKey),
    JSON.stringify({ version: 1, embedding: btoa(String.fromCharCode(...bytes)), createdAt: 42, modelSha256 }),
  );
}

async function signIn(id: string): Promise<string> {
  setMobileAuthOwner(id, 'global');
  await service.hydrateMobileSpeakerFilter();
  const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
  return getMobileAuthOwner().accountKey;
}

beforeEach(() => {
  vi.clearAllMocks();
  service.__testing.reset();
  asyncStore.clear();
  secureStore.clear();
  files.clear();
  sha.value = '';
  setMobileAuthOwner(null);
});

describe('mobile speaker filter', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['load', 'run'] as const)('bounds stalled native %s during enrollment', async (operation) => {
    installModels();
    await signIn('user-a');
    if (operation === 'load') vi.mocked(loadSpeakerModels).mockImplementationOnce(() => new Promise(() => {}));
    else vi.mocked(nativeSpeakerOnnxRunner.run).mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = service.enrollMobileSpeaker([new ArrayBuffer(32_000)]);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
    expect(setSecureItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the saved preference when local storage rejects a change', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(service.setMobileSpeakerFilterEnabled(true)).rejects.toThrow('disk full');
    expect(service.getMobileSpeakerFilterSnapshot().enabled).toBe(false);
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(service.setMobileSpeakerFilterStrictness('strict')).rejects.toThrow('disk full');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ strictness: 'standard', strictnessCustomized: false });
  });

  it('loads the new owner even when the previous owner hydration is still pending', async () => {
    let release!: (value: string | null) => void;
    vi.mocked(getSecureItem).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    setMobileAuthOwner('user-a', 'global');
    const old = service.hydrateMobileSpeakerFilter();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setMobileAuthOwner('user-b', 'global');
    const current = service.hydrateMobileSpeakerFilter();
    release(null);
    await Promise.all([old, current]);
    expect(service.getMobileSpeakerFilterSnapshot().hydrated).toBe(true);
    await service.setMobileSpeakerFilterStrictness('strict');
    expect(vi.mocked(AsyncStorage.setItem)).toHaveBeenCalledWith(
      expect.stringContaining('user-b'), expect.stringContaining('strict'),
    );
  });

  it('does not publish an old enrollment into the next account after secure storage completes', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(buildSpeakerEnrollment).mockResolvedValueOnce({ ok: true, embedding: Float32Array.of(1, 0), selfScore: 1, speechSec: 9 });
    let release!: () => void;
    vi.mocked(setSecureItem).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = service.enrollMobileSpeaker([]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await signIn('user-b');
    release();
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });

  it('keeps sign-out cleanup ordered after an in-flight secure write', async () => {
    installModels();
    const key = await signIn('user-a');
    vi.mocked(buildSpeakerEnrollment).mockResolvedValueOnce({ ok: true, embedding: Float32Array.of(1, 0), selfScore: 1, speechSec: 9 });
    let release!: () => void;
    vi.mocked(setSecureItem).mockImplementationOnce(async (name, value) => {
      await new Promise<void>((resolve) => { release = resolve; });
      secureStore.set(name, value);
    });
    const pending = service.enrollMobileSpeaker([]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setMobileAuthOwner(null);
    const { clearMobileSpeakerFilterForAccount } = await import('@/session/mobileSpeakerFilterStorage');
    const cleanup = clearMobileSpeakerFilterForAccount(key);
    await Promise.resolve();
    release();
    await Promise.all([pending, cleanup]);
    expect(secureStore.has(service.__testing.profileKey(key))).toBe(false);
  });

  it('honors cancellation before the first download task is created', async () => {
    await signIn('user-a');
    const download = service.downloadMobileSpeakerModels();
    service.cancelMobileSpeakerModelDownload();
    await download;
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('missing');
  });

  it('defaults to off and builds no gate', async () => {
    await signIn('user-a');
    const state = service.getMobileSpeakerFilterSnapshot();
    expect(state).toMatchObject({ hydrated: true, enabled: false, strictness: 'standard', enrolled: false });
    expect(service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('builds a gate only when on, enrolled and the models are on disk', async () => {
    installModels();
    setMobileAuthOwner('user-a', 'global');
    const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
    storeProfile(getMobileAuthOwner().accountKey);
    await service.hydrateMobileSpeakerFilter();
    expect(service.createMobileSpeakerGate()).toBeUndefined();

    await service.setMobileSpeakerFilterEnabled(true);
    expect(service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
  });

  it('ignores a voiceprint made by another model', async () => {
    installModels();
    setMobileAuthOwner('user-a', 'global');
    const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
    storeProfile(getMobileAuthOwner().accountKey, 'f'.repeat(64));
    await service.hydrateMobileSpeakerFilter();
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });

  it('keeps switch, strictness and voiceprint per account', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    service.__testing.reset();
    await signIn('user-a');
    await service.setMobileSpeakerFilterEnabled(true);
    await service.setMobileSpeakerFilterStrictness('strict');
    expect(JSON.parse(asyncStore.get(service.__testing.prefsKey(a))!)).toEqual({
      version: 1,
      enabled: true,
      strictnessOverride: 'strict',
    });

    await signIn('user-b');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ enabled: false, strictness: 'standard', enrolled: false });
    expect(service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('restoring the default strictness drops the override', async () => {
    const a = await signIn('user-a');
    await service.setMobileSpeakerFilterStrictness('relaxed');
    await service.setMobileSpeakerFilterStrictness(null);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ strictness: 'standard', strictnessCustomized: false });
    expect(JSON.parse(asyncStore.get(service.__testing.prefsKey(a))!).strictnessOverride).toBeUndefined();
  });

  it('hashes the account into the secure-store key', async () => {
    const key = service.__testing.profileKey('global:membership/with:odd chars');
    expect(key).toMatch(/^xdt\.voiceSpeakerProfile\.v1\.[0-9a-f]{32}$/);
  });

  it('downloads both models on first enable and verifies their hash', async () => {
    await signIn('user-a');
    await service.setMobileSpeakerFilterEnabled(true);
    await service.downloadMobileSpeakerModels();
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('ready');
    for (const asset of SPEAKER_MODEL_ASSETS) {
      expect(files.get(`file:///cache/voice-models/${speakerModelLocalName(asset)}`)).toBe(asset.bytes);
    }
  });

  it('rejects a download whose hash does not match and keeps nothing', async () => {
    await signIn('user-a');
    sha.value = '0'.repeat(64);
    await service.downloadMobileSpeakerModels();
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ modelState: 'failed', downloadError: 'checksum' });
    expect([...files.keys()]).toEqual([]);
  });

  it('sign-out clears that account\'s voiceprint and settings but keeps the models', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    await service.setMobileSpeakerFilterEnabled(true);
    const other = 'global:someone-else';
    storeProfile(other);

    const { clearMobileSpeakerFilterForAccount } = await import('@/session/mobileSpeakerFilterStorage');
    setMobileAuthOwner(null);
    await clearMobileSpeakerFilterForAccount(a);

    expect(secureStore.has(service.__testing.profileKey(a))).toBe(false);
    expect(asyncStore.has(service.__testing.prefsKey(a))).toBe(false);
    expect(secureStore.has(service.__testing.profileKey(other))).toBe(true);
    expect(files.size).toBe(SPEAKER_MODEL_ASSETS.length);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ enabled: false, enrolled: false });
    expect(service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('deletes the voiceprint', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    service.__testing.reset();
    await signIn('user-a');
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(true);
    await service.deleteMobileSpeakerProfile();
    expect(secureStore.has(service.__testing.profileKey(a))).toBe(false);
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });
});
