import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scope = vi.hoisted(() => ({ snapshot: null as unknown, row: {} as Record<string, unknown>, reply: null as { content: string } | null }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => scope.snapshot }));
import { messages } from '../../localDb/schema.js';
import { prepareChatReplyFiles, readReplyFile } from '../chatServerReplyFiles.js';

// #6761: production file preparation and descriptor reading. Group adapter tests mock
// this boundary; these unit cases verify real scope, bytes and Markdown (small temp files).
describe('group reply file delivery', () => {
  let root: string, work: string, pdf: string;
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-reply-files-')));
    work = path.join(root, 'task'); await fs.mkdir(work);
    pdf = path.join(work, 'report 中文.pdf');
    await fs.writeFile(path.join(root, 'private.pdf'), 'private');
  });
  beforeEach(async () => {
    await fs.writeFile(pdf, '%PDF-1.4\nreport');
    scope.row = { workingDir: work, remoteHostId: null, status: 'active', clearedAt: null };
    scope.reply = null;
    scope.snapshot = { client: { drizzle: { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => table === messages ? (scope.reply ? [scope.reply] : []) : [{ ...scope.row }] }) }) }) } } };
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('delivers explicit PDF links once with their bytes and removes local links from the body', async () => {
    const url = pathToFileURL(pdf).href.replace(/^file:/, 'xdt-file:');
    const result = await prepareChatReplyFiles(`[报告](${url}) and [再次](${url})`, 'lane', () => {});
    expect(result.text).toBe('报告 and 再次');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: path.basename(pdf), mimeType: 'application/pdf', path: null, url: null });
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
  });

  it('supports angle-bracket paths, relative and reference links without consuming images or examples', async () => {
    const body = `[报告](<${pdf}>)\n[再次][r]\n\n[r]: <${pdf}>\n\n\`[example](./x.pdf)\`\n![picture](./x.png)\n[web](https://example.test/r.pdf)`;
    const result = await prepareChatReplyFiles(body, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect(result.text).not.toContain(pdf);
    expect(result.text).toContain('`[example](./x.pdf)`');
    expect(result.text).toContain('![picture](./x.png)');
    expect(result.text).toContain('[web](https://example.test/r.pdf)');
    const relative = await prepareChatReplyFiles('[报告](<./report 中文.pdf>)', 'lane', () => {});
    expect((await relative.attachments[0]!.readBytes!()).length).toBeGreaterThan(0);
    const escaped = await prepareChatReplyFiles(`[报告](&lt;${pdf}&gt;)`, 'lane', () => {});
    expect(escaped.text).toBe('报告');
    expect((await escaped.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
  });

  it('preserves persisted Markdown for an empty SDK result without changing ordinary text replies', async () => {
    scope.reply = { content: JSON.stringify({ text: `[报告][r]\n\n[r]: <${pdf}>` }) };
    const result = await prepareChatReplyFiles(`[报告][r] [r]: <${pdf}>`, 'lane', () => {}, 'reply-client');
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
    expect(result.text.trim()).toBe('报告');
    scope.reply = { content: JSON.stringify({ text: 'First\nSecond' }) };
    expect(await prepareChatReplyFiles('First Second', 'lane', () => {}, 'reply-client')).toEqual({ text: 'First Second', attachments: [] });
  });

  it('does not access session scope for ordinary text, remote links, fenced examples or images', async () => {
    scope.snapshot = null;
    const text = '```md\n[example](./x.pdf)\n```\n![img](cindy-media://blobs/example.png)\n[web](https://example.test)';
    expect(await prepareChatReplyFiles(text, 'lane', () => { throw new Error('unexpected'); })).toEqual({ text, attachments: [] });
  });

  it.each(['../private.pdf', 'file://server/private.pdf', '//server/private.pdf'])('refuses an out-of-scope or network file %s', async url => {
    await expect(prepareChatReplyFiles(`[file](${url})`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('refuses a symlink escaping the task before reading its bytes', async () => {
    const link = path.join(work, 'escape');
    // A real directory junction also works on unprivileged Windows runners.
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = await prepareChatReplyFiles('[file](./escape/private.pdf)', 'lane', () => {});
      await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    } finally { await fs.unlink(link); }
  });

  it.each([{ remoteHostId: 'ssh-host' }, { status: 'deleted' }, { workingDir: null }])('refuses a task without local authority %j', async change => {
    Object.assign(scope.row, change);
    await expect(prepareChatReplyFiles('[file](./report.pdf)', 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('rechecks ownership, task clearing and the execution after preparation', async () => {
    let valid = true;
    const result = await prepareChatReplyFiles(`[file](<${pdf}>)`, 'lane', () => { if (!valid) throw new Error('STALE_EXECUTOR'); });
    scope.row.clearedAt = 1;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    scope.row.clearedAt = null;
    valid = false;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('STALE_EXECUTOR');
    valid = true; scope.snapshot = null;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('OWNER_CHANGED');
  });

  it('refuses changed bytes on retry instead of uploading a second version under the same reply', async () => {
    const result = await prepareChatReplyFiles(`[file](<${pdf}>)`, 'lane', () => {});
    const first = await result.attachments[0]!.readBytes!();
    expect(await result.attachments[0]!.readBytes!()).toEqual(first);
    await fs.writeFile(pdf, '%PDF-1.4\nchanged');
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('refuses too many files, empty files and directories', async () => {
    const text = Array.from({ length: 21 }, (_, i) => `[file](./${i}.pdf)`).join('\n');
    await expect(prepareChatReplyFiles(text, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    await fs.writeFile(pdf, '');
    await expect(readReplyFile(pdf, work, () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    await expect(readReplyFile(work, root, () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });
});
