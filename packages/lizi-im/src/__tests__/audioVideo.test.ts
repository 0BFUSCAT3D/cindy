import { describe, expect, it } from 'vitest';

import { audioVideoMimeOf } from '../audioVideo.js';

describe('audioVideoMimeOf', () => {
  it('trusts an audio/video MIME and normalizes parameters', () => {
    expect(audioVideoMimeOf('Video/MP4; codecs=avc1', 'x.bin')).toBe('video/mp4');
    expect(audioVideoMimeOf('audio/ogg', undefined)).toBe('audio/ogg');
  });

  it('falls back to the extension when the MIME is generic or missing', () => {
    expect(audioVideoMimeOf('application/octet-stream', 'clip.MP4')).toBe('video/mp4');
    expect(audioVideoMimeOf(undefined, 'voice.m4a')).toBe('audio/mp4');
    expect(audioVideoMimeOf('', 'movie.mkv')).toBe('video/x-matroska');
  });

  it('returns null for non audio/video files', () => {
    expect(audioVideoMimeOf('application/pdf', 'report.pdf')).toBeNull();
    expect(audioVideoMimeOf('application/octet-stream', 'archive.zip')).toBeNull();
    expect(audioVideoMimeOf(undefined, undefined)).toBeNull();
  });
});
