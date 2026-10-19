import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PLUGIN_ATTACHMENT_MAX_BYTES } from '../../../shared/pluginAttachments.js';

const state = vi.hoisted(() => ({ owner: { client: { drizzle: {} } }, ingest: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.owner }));
vi.mock('../blobStore.js', () => ({
  extForMime: (mime: string) => ({ 'image/png': '.png', 'image/jpeg': '.jpg' } as Record<string, string>)[mime],
  blobUrl: (hash: string, ext: string) => `cindy-media://blobs/${hash}${ext}`,
}));
vi.mock('../ingest.js', () => ({ ingestMedia: state.ingest }));
import { collectPluginAttachmentPayloadTexts, parsePluginMessageAttachments, withPluginMessageAttachments } from '../pluginMessageAttachments.js';

const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const base64 = bytes.toString('base64');
const hash = createHash('sha256').update(bytes).digest('hex');
const url = `cindy-media://blobs/${hash}.png`;
const images = () => parsePluginMessageAttachments([{ base64, name: 'window.png' }]);
afterEach(() => { state.ingest.mockReset(); expect(collectPluginAttachmentPayloadTexts()).toEqual([]); });

describe('plugin message image delivery', () => {
  // Production boundary: parsePluginMessageAttachments. No URL/path reads or caller MIME trust.
  it.each([
    [{ url }], [{ path: '/private/window.png', base64 }], [{ base64, mimeType: 'image/png' }],
    [{ base64: 'not image===' }], [{ base64: Buffer.from('plain text').toString('base64') }],
    [{ base64, name: '../window.png' }], Array.from({ length: 5 }, () => ({ base64 })),
    [{ base64: 'A'.repeat(Math.ceil(PLUGIN_ATTACHMENT_MAX_BYTES / 3) * 4 + 4) }],
  ].map(value => ({ value })))('rejects invalid or oversized attachments before ingestion', ({ value }) => {
    expect(() => parsePluginMessageAttachments(value)).toThrow('INVALID_ATTACHMENTS');
    expect(state.ingest).not.toHaveBeenCalled();
  });
  it('detects the image from bytes and protects it through the durable handoff', async () => {
    state.ingest.mockImplementation(async (input: { assertStillValid: () => void }, db: unknown) => {
      input.assertStillValid();
      expect(db).toBe(state.owner.client.drizzle);
      expect(collectPluginAttachmentPayloadTexts().join('')).toContain(url);
      return { url, mimeType: 'image/png', ext: '.png', bytes: bytes.length };
    });
    const result = await withPluginMessageAttachments(images(), () => {}, async files => {
      expect(files).toMatchObject([{ url, category: 'image', mimeType: 'image/png', path: '', originalName: 'window.png' }]);
      expect(files[0]).not.toHaveProperty('base64');
      expect(collectPluginAttachmentPayloadTexts().join('')).toContain(url);
      return 'persisted';
    });
    expect(result).toBe('persisted');
    expect(state.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [], isCache: false }), state.owner.client.drizzle);
  });
  it.each(['SUPERSEDED', 'DELIVERY_REJECTED', 'DELIVERY_UNCERTAIN'])('releases only in-flight protection after %s without replaying', async code => {
    state.ingest.mockResolvedValue({ url, mimeType: 'image/png', ext: '.png', bytes: bytes.length });
    const deliver = vi.fn(async () => { throw new Error(code); });
    await expect(withPluginMessageAttachments(images(), () => {}, deliver)).rejects.toThrow(code);
    expect(deliver).toHaveBeenCalledOnce();
    // Any adopted queue/message is protected by the existing queue and chat ref owners.
    expect(collectPluginAttachmentPayloadTexts()).toEqual([]);
  });
  it('rejects a stale owner after ingestion and never submits to the new account', async () => {
    state.ingest.mockImplementation(async () => {
      state.owner = { client: { drizzle: {} } };
      return { url, mimeType: 'image/png', ext: '.png', bytes: bytes.length };
    });
    const deliver = vi.fn();
    await expect(withPluginMessageAttachments(images(), () => {}, deliver)).rejects.toThrow('PERMISSION_DENIED');
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not deliver after an import failure; a retry imports the same content safely', async () => {
    const deliver = vi.fn(async () => 'accepted');
    state.ingest.mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ url, mimeType: 'image/png', ext: '.png', bytes: bytes.length });
    await expect(withPluginMessageAttachments(images(), () => {}, deliver)).rejects.toThrow('write failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(await withPluginMessageAttachments(images(), () => {}, deliver)).toBe('accepted');
    expect(deliver).toHaveBeenCalledOnce();
  });
});
