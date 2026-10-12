import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { speakerModelAsset } from '@cindy/voice-input-core';

import {
  SpeakerProfileStorageUnavailableError,
  SpeakerProfileStore,
  type SpeakerProfileCipher,
} from '../speakerProfileStore';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-profile-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Reversible stand-in for safeStorage that is visibly not plaintext. */
function fakeCipher(available = true): SpeakerProfileCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf-8').map((byte) => byte ^ 0x5a)),
    decrypt: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf-8'),
  };
}

describe('SpeakerProfileStore', () => {
  it('round-trips the voiceprint through the cipher and never writes it in plain text', () => {
    const file = path.join(dir, 'owners', 'a', 'voice-speaker-profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.from([0.25, -0.5, 0.125]), 1_700_000_000_000);

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('0.25');
    expect(raw).not.toContain('embedding');

    const fresh = new SpeakerProfileStore(() => file, fakeCipher());
    const profile = fresh.read();
    expect(Array.from(profile?.embedding ?? [])).toEqual([0.25, -0.5, 0.125]);
    expect(profile?.createdAt).toBe(1_700_000_000_000);
  });

  it('keeps each account separate', () => {
    let owner = 'a';
    const store = new SpeakerProfileStore(() => path.join(dir, owner, 'profile.json'), fakeCipher());
    store.write(Float32Array.from([1, 0]));
    owner = 'b';
    expect(store.read()).toBeNull();
  });

  it('reads a voiceprint from another embedding model as not enrolled', () => {
    const file = path.join(dir, 'profile.json');
    const cipher = fakeCipher();
    const payload = { embedding: [1, 0], createdAt: 1, modelSha256: 'f'.repeat(64) };
    fs.writeFileSync(file, JSON.stringify({ version: 1, data: cipher.encrypt(JSON.stringify(payload)).toString('base64') }));
    expect(speakerModelAsset('embedding').sha256).not.toBe('f'.repeat(64));
    expect(new SpeakerProfileStore(() => file, cipher).read()).toBeNull();
  });

  it('treats corrupt or undecryptable files as not enrolled', () => {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, '{not json');
    expect(new SpeakerProfileStore(() => file, fakeCipher()).read()).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ version: 1, data: 'AAAA' }));
    const throwing: SpeakerProfileCipher = {
      ...fakeCipher(),
      decrypt: () => {
        throw new Error('keychain locked');
      },
    };
    expect(new SpeakerProfileStore(() => file, throwing).read()).toBeNull();
  });

  it('refuses to write without OS encryption and leaves no file behind', () => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher(false));
    expect(() => store.write(Float32Array.from([1]))).toThrow(SpeakerProfileStorageUnavailableError);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('deletes the voiceprint file and its cached copy', () => {
    const file = path.join(dir, 'profile.json');
    const store = new SpeakerProfileStore(() => file, fakeCipher());
    store.write(Float32Array.from([1, 0]));
    expect(store.read()).not.toBeNull();
    store.delete();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toBeNull();
  });
});
