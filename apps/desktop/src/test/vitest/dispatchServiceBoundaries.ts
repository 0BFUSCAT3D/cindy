import { afterEach, expect, vi } from 'vitest';

// Dispatch suites exercise real authorization, subscriptions and routing. These
// separate services are outside those assertions; importing them would also
// bootstrap the voice/agent runtimes. Fail if a case crosses that boundary,
// including when dispatch catches the error and returns an IPC failure.
const boundary = vi.hoisted(() => ({
  calls: [] as string[],
  reject(service: string): never {
    this.calls.push(service);
    throw new Error(`Unexpected service call in dispatch fixture: ${service}`);
  },
}));

vi.mock('../../main/task-migration/service', () => ({
  requestTaskMigration: () => boundary.reject('task migration'),
}));
vi.mock('../../main/remote-desktop/iceConfig', () => ({
  loadDesktopIceServers: () => boundary.reject('ICE configuration'),
}));
vi.mock('../../main/device-link/mediaFetch', () => ({
  fetchLocalMediaToOss: () => boundary.reject('media upload'),
}));
vi.mock('../../main/device-link/voiceTranscribe', () => ({
  transcribeRemoteVoiceInput: () => boundary.reject('voice transcription'),
}));
vi.mock('../../main/voice-input/index.js', () => ({
  adviseAndRecordVoiceInputDictionaryLearning: () => boundary.reject('voice dictionary learning'),
}));

afterEach(() => {
  expect(boundary.calls.splice(0)).toEqual([]);
});
