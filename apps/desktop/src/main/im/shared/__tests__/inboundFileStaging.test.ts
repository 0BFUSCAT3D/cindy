import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ root: '' }));

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(holder.root, ...parts),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  adoptStagedInboundFiles,
  removeImSessionAttachmentDirs,
  resetInboundFileStagingForTests,
  sanitizeInboundFileName,
  STAGING_MAX_AGE_MS,
  stageInboundFile,
} from '../inboundFileStaging';

beforeEach(() => {
  holder.root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-inbound-files-'));
  resetInboundFileStagingForTests();
});

afterEach(() => {
  fs.rmSync(holder.root, { recursive: true, force: true });
});

describe('inbound file staging', () => {
  it('stages under the owner-scoped im-attachments tree, never a legacy media dir', async () => {
    const staged = await stageInboundFile({
      integration: 'telegram',
      buffer: Buffer.from('pdf'),
      fileName: 'report.pdf',
    });
    expect(staged.absPath.startsWith(path.join(holder.root, 'im-attachments', 'telegram', 'staging'))).toBe(true);
    expect(staged.absPath.endsWith('-report.pdf')).toBe(true);
    expect(fs.readFileSync(staged.absPath, 'utf8')).toBe('pdf');
    await staged.discard();
    expect(fs.existsSync(staged.absPath)).toBe(false);
  });

  it('sanitizes untrusted platform file names', () => {
    expect(sanitizeInboundFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeInboundFileName('a<b>:c.pdf')).toBe('a_b__c.pdf');
    expect(sanitizeInboundFileName('...')).toBe('attachment');
    expect(sanitizeInboundFileName(`${'x'.repeat(300)}.docx`)).toHaveLength(120);
  });

  it('moves staged files into the task directory in place and is idempotent', async () => {
    const staged = await stageInboundFile({ integration: 'feishu', buffer: Buffer.from('doc'), fileName: 'a.docx' });
    const outside = { kind: 'file' as const, absPath: '/blobs/x.mp4', originalName: 'x.mp4', mimeType: 'video/mp4' };
    const attachment = { kind: 'file' as const, absPath: staged.absPath, originalName: 'a.docx', mimeType: 'x' };

    await adoptStagedInboundFiles('session-1', [attachment, outside]);
    const expectedDir = path.join(holder.root, 'im-attachments', 'feishu', 'sessions', 'session-1');
    expect(path.dirname(attachment.absPath)).toBe(expectedDir);
    expect(fs.readFileSync(attachment.absPath, 'utf8')).toBe('doc');
    expect(fs.existsSync(staged.absPath)).toBe(false);
    expect(outside.absPath).toBe('/blobs/x.mp4');

    const adopted = attachment.absPath;
    await adoptStagedInboundFiles('session-2', [attachment]);
    expect(attachment.absPath).toBe(adopted);
  });

  it('refuses session ids that would escape the sessions root', async () => {
    const staged = await stageInboundFile({ integration: 'discord', buffer: Buffer.from('z'), fileName: 'z.zip' });
    const attachment = { kind: 'file' as const, absPath: staged.absPath, originalName: 'z.zip', mimeType: 'x' };
    await adoptStagedInboundFiles('../escape', [attachment]);
    expect(attachment.absPath).toBe(staged.absPath);
  });

  it('removes every channel directory of a deleted task, including WeChat', async () => {
    for (const channel of ['telegram', 'wechat']) {
      const dir = path.join(holder.root, 'im-attachments', channel, 'sessions', 'gone');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f.pdf'), 'x');
    }
    const keep = path.join(holder.root, 'im-attachments', 'telegram', 'sessions', 'kept');
    fs.mkdirSync(keep, { recursive: true });

    await removeImSessionAttachmentDirs('gone');
    expect(fs.existsSync(path.join(holder.root, 'im-attachments', 'telegram', 'sessions', 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(holder.root, 'im-attachments', 'wechat', 'sessions', 'gone'))).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('sweeps unclaimed staging files past the age limit on the next stage', async () => {
    const old = await stageInboundFile({ integration: 'wecom', buffer: Buffer.from('old'), fileName: 'old.pdf' });
    const past = new Date(Date.now() - STAGING_MAX_AGE_MS - 60_000);
    fs.utimesSync(old.absPath, past, past);
    resetInboundFileStagingForTests();

    const fresh = await stageInboundFile({ integration: 'wecom', buffer: Buffer.from('new'), fileName: 'new.pdf' });
    await vi.waitFor(() => expect(fs.existsSync(old.absPath)).toBe(false));
    expect(fs.existsSync(fresh.absPath)).toBe(true);
  });
});
