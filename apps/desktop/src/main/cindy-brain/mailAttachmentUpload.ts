import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseAttachmentOssRef, parsePeerAttachmentRef } from '@cindy/device-link';

const parseUploadRef = (url: string) => parsePeerAttachmentRef(url) || parseAttachmentOssRef(url);

export interface MailAttachmentUpload { url: string; name: string }
export function parseMailAttachmentUpload(value: unknown): MailAttachmentUpload | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.url !== 'string' || p.url.length > 8192 || typeof p.name !== 'string' ||
      !p.name.trim() || p.name.length > 255 || /[\\/\x00-\x1f]/.test(p.name)) return null;
  const ref = parseUploadRef(p.url);
  if (!ref || !Number.isSafeInteger(ref.size) || ref.size! < 0 || ref.size! > 16 * 1024 * 1024 ||
      !ref.sha256 || !/^[a-f0-9]{64}$/.test(ref.sha256)) return null;
  return { url: p.url, name: p.name };
}

/** Reuse task attachment materialization and its owner/session cleanup. Never
 * accept a phone-supplied desktop path, or create a second upload store. */
export async function prepareMailAttachmentUpload(input: MailAttachmentUpload, sessionId: string) {
  const upload = parseMailAttachmentUpload(input);
  if (!upload) throw new Error('INVALID_MAIL_ATTACHMENT');
  const ref = parseUploadRef(upload.url)!;
  const { materializeDirectSendOssAttachments } = await import('../maker-ipc/normalizeAttachments.js');
  const staged = await materializeDirectSendOssAttachments(sessionId, {
    type: 'user', content: [{ type: 'file', path: upload.url, name: upload.name, mimeType: ref.mimeType }],
  }, {});
  const discard = async () => { await staged.cleanupBeforeAcceptance?.(); };
  try {
    const file = (staged.message as { content: { path: string }[] }).content[0].path;
    if (file === upload.url) throw new Error('MAIL_ATTACHMENT_NOT_MATERIALIZED');
    const bytes = await fs.readFile(file);
    if (bytes.length !== ref.size || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
      throw new Error('MAIL_ATTACHMENT_INTEGRITY');
    return {
      attachment: { path: file, filename: upload.name, bytes: bytes.length, sha256: ref.sha256 },
      accepted: () => staged.cleanupAfterAcceptance?.(),
      discard,
    };
  } catch (error) { await discard(); throw error; }
}
