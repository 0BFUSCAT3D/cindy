import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Definition } from 'mdast';
import { messages, sessions } from '../localDb/schema.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { isPathWithin } from '../cindy-media/taskImageMarkdown.js';
import { BOT_GROUP_ATTACHMENTS_MAX } from '../../shared/botGroupChat.js';
import type { ChatUploadAttachment } from './chatServerMedia.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const MAX_BYTES = 100 * 1024 * 1024;
const unavailable = () => new Error('ATTACHMENT_UNAVAILABLE');

// Local Markdown line locators follow sharedTaskFileReferences/markdownTarget.
// Query-based URLs carry an explicit path; do not rewrite its literal filename.
function withoutLineLocator(value: string): string {
  return value.includes('?') ? value : value.replace(/(?::\d+(?::\d+|-\d+)?|#L\d+(?:-L\d+)?)$/, '');
}

// Match local references, not arbitrary URI schemes or in-message anchors.
function isFileTarget(value: string): boolean {
  if (!value || /^[#?]/.test(value)) return false;
  value = withoutLineLocator(value);
  if (/^(?:file|xdt-file|sandbox):/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** Only actual Markdown file links are deliveries; code, images and remote URLs are not. */
export function replyFileLinks(text: string) {
  // The reported reply HTML-escaped the angle brackets around paths with spaces.
  // Recover only these file links in prose, never examples inside code or HTML.
  const escaped: Array<{ start: number; end: number; text: string }> = [];
  visit(parser.parse(text), 'text', node => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = text.slice(start, end);
    const normalized = raw.replace(/(\[[^\]\n]+\]\()&lt;([^\n]*?)&gt;(\))/g,
      (match, before, target, after) => isFileTarget(target) ? `${before}<${target}>${after}` : match);
    if (normalized !== raw) escaped.push({ start, end, text: normalized });
  });
  for (const edit of escaped.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  visit(tree, 'definition', node => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const links: Array<{ url: string; start: number; end: number; label: string }> = [];
  const usedDefinitions = new Set<string>();
  const imageDefinitions = new Set<string>();
  visit(tree, 'imageReference', node => { imageDefinitions.add(node.identifier); });
  visit(tree, node => {
    if (node.type !== 'link' && node.type !== 'linkReference') return;
    const target = node.type === 'link' ? node : definitions.get(node.identifier);
    if (!target || !isFileTarget(target.url)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    const first = node.children[0]?.position?.start.offset, last = node.children.at(-1)?.position?.end.offset;
    // A linked image belongs to image delivery, not this file path.
    if (node.children.some(child => child.type === 'image' || child.type === 'imageReference')) return;
    if (start === undefined || end === undefined || first === undefined || last === undefined) return;
    links.push({ url: target.url, start, end, label: text.slice(first, last) });
    if (node.type === 'linkReference') usedDefinitions.add(node.identifier);
  });
  const edits = links.map(link => ({ start: link.start, end: link.end, text: link.label }));
  for (const identifier of usedDefinitions) {
    const node = definitions.get(identifier)!;
    if (!imageDefinitions.has(identifier) && node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      edits.push({ start: node.position.start.offset, end: node.position.end.offset, text: '' });
  }
  let deliveredText = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    deliveredText = deliveredText.slice(0, edit.start) + edit.text + deliveredText.slice(edit.end);
  return { links, text: deliveredText };
}

function localPath(url: string, workDir: string): string {
  url = withoutLineLocator(url);
  let value = url;
  try {
    if (/^sandbox:/i.test(url)) {
      const match = /^sandbox:\/*(?:([a-z]:[\\/][^\n]*)|(\/[^\n]*))$/i.exec(url);
      if (!match) throw unavailable();
      value = match[1] ?? match[2]!;
    } else if (/^xdt-file:/i.test(url)) {
      const parsed = new URL(url);
      // A remote reference must never be interpreted as a path on this machine.
      if (parsed.searchParams.has('remoteHostId') || parsed.username || parsed.password) throw unavailable();
      if (parsed.searchParams.has('path')) {
        if (!['', 'local', 'open'].includes(parsed.hostname)) throw unavailable();
        value = parsed.searchParams.get('path')!;
        if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) throw unavailable();
      } else value = fileURLToPath(url.replace(/^xdt-file:/i, 'file:'));
    } else if (/^file:/i.test(url)) value = fileURLToPath(url);
  } catch { throw unavailable(); }
  // Never resolve a network/device path, including on another host platform.
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(value) || value.includes('\0')) throw unavailable();
  if (/^[A-Za-z]:/.test(value) && process.platform !== 'win32') throw unavailable();
  return path.resolve(workDir, value);
}

/** One descriptor, bounded reads and inode checks keep a symlink swap from exporting another file. */
export async function readReplyFile(source: string, root: string, assertCurrent: () => void): Promise<Buffer> {
  assertCurrent();
  if (!isPathWithin(root, source)) throw unavailable();
  const real = await fs.realpath(source);
  if (!isPathWithin(root, real)) throw unavailable();
  const expected = await fs.stat(real, { bigint: true });
  // A hard link can point to an inode also named outside this task directory.
  // realpath cannot prove that all of its other names are in scope.
  if (expected.nlink !== 1n) throw unavailable();
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    const checked = await fs.realpath(source);
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_BYTES)) throw unavailable();
    if (before.ino === 0n || expected.ino !== before.ino || expected.dev !== before.dev || checked !== real) throw unavailable();
    assertCurrent();
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw unavailable();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw unavailable();
    assertCurrent();
    return buffer;
  } finally { await handle.close(); }
}

/** Files stay outside the media store; the existing group uploader receives authorized bytes. */
export async function prepareChatReplyFiles(text: string, sessionId: string, assertExecution: () => void, fallbackMessageClientId?: string | null) {
  const snapshot = getCurrentDbClientSnapshot();
  let markdown = text;
  if (fallbackMessageClientId) {
    if (!snapshot) throw unavailable();
    const [row] = await snapshot.client.drizzle.select({ content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, fallbackMessageClientId),
        eq(messages.role, 'assistant'), isNull(messages.rewindAt))).limit(1);
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('OWNER_CHANGED');
    // The existing search projection flattens newlines. Only file delivery needs the
    // original Markdown; scheduling and replies without file links keep their old input.
    markdown = row ? visibleMessageText('assistant', row.content) : text;
  }
  const parsed = replyFileLinks(markdown);
  if (!parsed.links.length) return { text, attachments: [] as ChatUploadAttachment[] };
  if (!snapshot) throw unavailable();
  const assertCurrent = () => {
    assertExecution();
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('OWNER_CHANGED');
  };
  const readSession = async () => {
    const [row] = await snapshot.client.drizzle.select({ workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId, status: sessions.status, clearedAt: sessions.clearedAt })
      .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    assertCurrent();
    if (!row?.workingDir || row.remoteHostId || row.status === 'deleted') throw unavailable();
    return row;
  };
  const scope = await readSession();
  const root = await fs.realpath(scope.workingDir!);
  assertCurrent();
  const attachments: ChatUploadAttachment[] = [];
  const seen = new Set<string>();
  for (const link of parsed.links) {
    const source = localPath(link.url, scope.workingDir!);
    // /tmp can alias /private/tmp; normalize the trusted workdir prefix without following the file.
    const lexicalRoot = path.resolve(scope.workingDir!);
    if (!isPathWithin(lexicalRoot, source) && !isPathWithin(root, source)) throw unavailable();
    const canonicalSource = isPathWithin(root, source) ? source : path.resolve(root, path.relative(lexicalRoot, source));
    if (seen.has(canonicalSource)) continue;
    if (attachments.length >= BOT_GROUP_ATTACHMENTS_MAX) throw unavailable();
    seen.add(canonicalSource);
    let digest: string | undefined;
    attachments.push({ id: canonicalSource, name: path.basename(source), category: 'file',
      mimeType: path.extname(source).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream',
      size: 0, path: null, url: null, assertCurrent,
      readBytes: async () => {
        const current = await readSession();
        if (current.workingDir !== scope.workingDir || current.clearedAt !== scope.clearedAt
          || await fs.realpath(current.workingDir!) !== root) throw unavailable();
        const bytes = await readReplyFile(canonicalSource, root, assertCurrent);
        const next = createHash('sha256').update(bytes).digest('hex');
        if (digest && digest !== next) throw unavailable();
        digest = next;
        return bytes;
      } });
  }
  return { text: parsed.text, attachments };
}
