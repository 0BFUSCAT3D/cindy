import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ read: vi.fn(), session: vi.fn(), realpath: vi.fn(), query: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ query: deps.query }) }));
vi.mock('node:fs/promises', () => ({ realpath: deps.realpath }));
vi.mock('../../cindy-media/blobStore.js', () => ({ parseBlobUrl: (url: string) => url === 'cindy-media://blobs/hash.png' ? { hash: 'hash' } : null }));
vi.mock('../../cindy-media/ledger.js', () => ({ sessionCanRead: deps.read }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionFsSnapshot: deps.session }));
import { assertSharedTaskMedia } from '../sharedTaskMediaAccess.js';
import type { SharedTaskPeerCapture } from '../sharedTaskDispatch.js';
let current = true;
// Markdown destinations use forward separators; native path assertions do not.
const markdownPath = (file: string) => file.split(path.sep).join('/');
const capture: SharedTaskPeerCapture = {
  author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'm', accountId: 'u', displayName: 'Guest' },
  isCurrent: () => current, authorize: () => current,
};
beforeEach(() => {
  vi.resetAllMocks(); current = true;
  deps.realpath.mockImplementation(async (value: string) => path.resolve(value));
  deps.session.mockResolvedValue({ workingDir: path.resolve('workspace'), remoteHostId: null });
  deps.query.mockResolvedValue([]);
});
describe('shared task media access', () => {
  // Regression: a delivered file outside the workdir must be readable, without
  // granting its directory or trusting a guest's pasted path (unit tier).
  it.each(['assistant', 'user'])('reads an outside file linked by the %s in this task', async (role) => {
    const file = path.resolve('deliveries/report final.pdf');
    deps.query.mockResolvedValue([{ rowid: 1, role, content: JSON.stringify({ text: `[report](<${markdownPath(file)}>)` }), agentMeta: null }]);
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file), capture))
      .resolves.toEqual({ file });
  });
  it('reads owner attachments outside the workdir without authorizing their siblings', async () => {
    const file = path.resolve('uploads/report.pdf');
    deps.query.mockResolvedValue([{ rowid: 1, role: 'user', content: JSON.stringify({ files: [{ path: file }] }), agentMeta: null }]);
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file), capture)).resolves.toEqual({ file });
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file + '.secret'), capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('does not treat a guest message as authority for outside files', async () => {
    const file = path.resolve('other/private.pdf');
    deps.query.mockResolvedValue([{ rowid: 1, role: 'user', content: JSON.stringify({ text: `[file](<${markdownPath(file)}>)` }), agentMeta: JSON.stringify({ sharedTaskAuthor: { memberId: 'm' } }) }]);
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file), capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('reads host-materialized guest attachments but not a JSON-looking guest message', async () => {
    const file = path.resolve('uploads/report%20final.pdf');
    const content = { files: [{ path: file }] };
    const row = { rowid: 1, role: 'user', agentMeta: JSON.stringify({ sharedTaskAuthor: { memberId: 'm' } }) };
    const url = 'xdt-file://local?path=' + encodeURIComponent(file);
    deps.query.mockResolvedValueOnce([{ ...row, content: JSON.stringify(content) }]);
    await expect(assertSharedTaskMedia(url, capture)).resolves.toEqual({ file });
    deps.query.mockResolvedValue([{ ...row, content: JSON.stringify(JSON.stringify(content)) }]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('rechecks membership after reading outside-file provenance', async () => {
    const file = path.resolve('deliveries/report.pdf');
    deps.query.mockImplementation(async () => { current = false; return [{ rowid: 1, role: 'assistant', content: JSON.stringify(`[report](<${markdownPath(file)}>)`) }]; });
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file), capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it.each(['inline', 'reference', 'encoded', 'audio', 'tool-result'])('recognizes an exact outside-file reference in %s form', async (kind) => {
    const file = path.resolve('deliveries/report (final).pdf');
    const url = 'xdt-file://local?path=' + encodeURIComponent(file).replace(/\(/g, '%28').replace(/\)/g, '%29');
    const content = kind === 'inline' ? '`' + file + '`'
      : kind === 'reference' ? `[report][r]\n\n[r]: <${markdownPath(file)}>`
      : kind === 'encoded' ? `[report](<${pathToFileURL(file).href}>)`
      : url;
    deps.query.mockResolvedValue([{ rowid: 1, role: kind === 'tool-result' ? 'tool_result' : 'assistant', content: JSON.stringify(content) }]);
    await expect(assertSharedTaskMedia(kind === 'audio' ? url.replace('xdt-file:', 'xdt-audio:') : url, capture)).resolves.toEqual({ file });
  });
  it.each(['fenced', 'unused-definition', 'prefix', 'remote-host'])('rejects %s text that does not deliver this local file', async (kind) => {
    const file = path.resolve('deliveries/report.pdf');
    const content = kind === 'fenced' ? '```md\n[report](<' + markdownPath(file) + '>)\n```'
      : kind === 'unused-definition' ? `[r]: <${markdownPath(file)}>`
      : kind === 'remote-host' ? `[report](xdt-file://local?path=${encodeURIComponent(file)}&remoteHostId=ssh)`
      : `[report](<${markdownPath(file)}.secret>)`;
    deps.query.mockResolvedValue([{ rowid: 1, role: 'assistant', content: JSON.stringify(content) }]);
    await expect(assertSharedTaskMedia('xdt-file://local?path=' + encodeURIComponent(file), capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('reads a generated file only after its matching tool completes successfully', async () => {
    const file = path.resolve('deliveries/report.pdf');
    const row = { rowid: 1, role: 'tool_use', toolUseId: 'write-1', content: JSON.stringify({ toolName: 'Write', input: { file_path: file, content: 'report' } }) };
    const url = 'xdt-file://local?path=' + encodeURIComponent(file);
    for (const result of [null, '<tool_use_error>Permission denied</tool_use_error>', { ok: false }, 'File written']) {
      deps.query.mockResolvedValueOnce([row]).mockResolvedValueOnce(result === null ? [] : [{ content: JSON.stringify(result) }]);
      if (result === 'File written') await expect(assertSharedTaskMedia(url, capture)).resolves.toEqual({ file });
      else await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
    }
  });
  it('does not cache file grants and scopes the history query to live messages in the current task', async () => {
    const file = path.resolve('deliveries/report.pdf');
    const url = 'xdt-file://local?path=' + encodeURIComponent(file);
    deps.query.mockResolvedValueOnce([{ rowid: 1, role: 'assistant', content: JSON.stringify(`[report](<${markdownPath(file)}>)`) }]).mockResolvedValueOnce([]);
    await expect(assertSharedTaskMedia(url, capture)).resolves.toEqual({ file });
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
    // These query predicates are the cross-task/rewind authorization boundary.
    expect(deps.query.mock.calls[0][0]).toContain('session_id = ? AND rewind_at IS NULL');
    expect(deps.query.mock.calls[0][1][0]).toBe('task');
  });
  it('allows legacy generated media only when its complete URL occurs in host-authored task history', async () => {
    const url = 'xdt-video://art/clip.mp4';
    deps.query.mockResolvedValue([{ content: JSON.stringify({ text: '[video](' + url + ')' }) }]);
    await assertSharedTaskMedia(url, capture);
    expect(deps.query.mock.calls[0][0]).toContain("role IN ('assistant', 'tool_use', 'tool_result')");
    expect(deps.query.mock.calls[0][1]).toEqual(['task', url]);
    deps.query.mockResolvedValue([{ content: url + '.other' }]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.query.mockResolvedValue([]);
    await expect(assertSharedTaskMedia(url, capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('requires task provenance even for a known managed blob', async () => {
    deps.read.mockResolvedValue(false);
    await expect(assertSharedTaskMedia('cindy-media://blobs/hash.png', capture)).rejects.toThrow('PERMISSION_DENIED');
    deps.read.mockResolvedValue(true);
    await assertSharedTaskMedia('cindy-media://blobs/hash.png', capture);
    expect(deps.read).toHaveBeenLastCalledWith('hash', 'task');
  });
  it('rechecks membership after asynchronous ledger reads', async () => {
    deps.read.mockImplementation(async () => { current = false; return true; });
    await expect(assertSharedTaskMedia('cindy-media://blobs/hash.png', capture)).rejects.toThrow('PERMISSION_DENIED');
  });
  it('permits task workdir media but rejects siblings and symlink escapes', async () => {
    const url = (file: string) => 'xdt-file://local?path=' + encodeURIComponent(path.resolve(file));
    await assertSharedTaskMedia(url('workspace/art.png'), capture);
    await expect(assertSharedTaskMedia(url('other/private.png'), capture)).rejects.toThrow();
    deps.realpath.mockImplementation(async (file: string) => file.endsWith('link.png') ? path.resolve('other/private.png') : path.resolve(file));
    await expect(assertSharedTaskMedia(url('workspace/link.png'), capture)).rejects.toThrow();
  });
  it('requires exact SSH task and host provenance before materialization', async () => {
    deps.session.mockResolvedValue({ workingDir: '/work', remoteHostId: 'ssh' });
    const url = 'xdt-file://local?path=/work/a.png&sessionId=task&remoteHostId=ssh&workdir=/work';
    await assertSharedTaskMedia(url, capture);
    await expect(assertSharedTaskMedia(url.replace('sessionId=task', 'sessionId=other'), capture)).rejects.toThrow();
    await expect(assertSharedTaskMedia('xdt-file://local?path=/work/a.png', capture)).rejects.toThrow();
    expect(deps.realpath).not.toHaveBeenCalled();
  });
  it('keeps legacy task image history scoped to its actual session', async () => {
    await assertSharedTaskMedia('xdt-image://task/photo.png', capture);
    await expect(assertSharedTaskMedia('xdt-image://other/photo.png', capture)).rejects.toThrow();
  });
});
