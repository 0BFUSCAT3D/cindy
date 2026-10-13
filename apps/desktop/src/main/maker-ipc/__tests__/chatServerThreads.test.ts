import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadProjection, isShareableThreadReply, threadPreviewAttachments, threadPreviewText, type ThreadMessage } from '../chatServerThreads.js';
import { buildBotGroupThreadShareCard } from '../../../shared/botGroupChat.js';

const room = '10000000-0000-4000-8000-000000000001';
const rootA = '20000000-0000-4000-8000-00000000000a';
const rootB = '20000000-0000-4000-8000-00000000000b';
let seq = 0;
function message(overrides: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  seq += 1;
  return { seq: String(seq), authorId: 'author', deleted: false, threadRootId: null, content: [{ type: 'text', text: overrides.id }], ...overrides };
}
const reply = (id: string, rootId: string, extra: Partial<ThreadMessage> = {}) => message({ id, threadRootId: rootId, ...extra });
const fullWindow = (messages: ThreadMessage[]) => [...messages, ...Array.from({ length: 100 - messages.length }, (_, i) => message({ id: `filler-${i}` }))];

describe('thread previews', () => {
  const io = { threadPage: vi.fn(), message: vi.fn() };
  let projection: ReturnType<typeof createThreadProjection<ThreadMessage>>;
  beforeEach(() => { io.threadPage.mockReset(); io.message.mockReset(); projection = createThreadProjection(io); });
  afterEach(() => vi.useRealTimers());

  it('uses the snapshot window for active threads without any extra request', async () => {
    const root = message({ id: rootA, replyCount: 3 });
    // Newest first, like the server snapshot; a deleted reply never previews.
    const window = fullWindow([reply('r3', rootA), reply('gone', rootA, { deleted: true }), reply('r2', rootA), reply('r1', rootA)]);
    const previews = await projection.previews(room, [root], window);
    expect(previews.get(rootA)!.map(m => m.id)).toEqual(['r2', 'r3']);
    expect(io.threadPage).not.toHaveBeenCalled();
  });

  it('treats a short snapshot as the whole history', async () => {
    const root = message({ id: rootA, replyCount: 1 });
    const previews = await projection.previews(room, [root], [reply('only', rootA)]);
    expect(previews.get(rootA)!.map(m => m.id)).toEqual(['only']);
    expect(io.threadPage).not.toHaveBeenCalled();
  });

  it('reads one bounded page only for quiet threads and caches it until the count changes', async () => {
    const root = message({ id: rootB, replyCount: 2 });
    io.threadPage.mockResolvedValue([reply('b2', rootB), reply('b1', rootB)]);
    const window = fullWindow([]);
    expect((await projection.previews(room, [root], window)).get(rootB)!.map(m => m.id)).toEqual(['b1', 'b2']);
    expect(io.threadPage).toHaveBeenCalledWith(room, rootB, 6);
    await projection.previews(room, [root], window);
    expect(io.threadPage).toHaveBeenCalledTimes(1);
    // A new reply changes the count, so the cached page is no longer trusted.
    await projection.previews(room, [{ ...root, replyCount: 3 }], window);
    expect(io.threadPage).toHaveBeenCalledTimes(2);
  });

  it('drops a cached page when one of its replies is edited or deleted, and resets after reconnect', async () => {
    const root = message({ id: rootB, replyCount: 1 });
    io.threadPage.mockResolvedValue([reply('b1', rootB)]);
    await projection.previews(room, [root], fullWindow([]));
    projection.invalidate(room, 'unrelated');
    await projection.previews(room, [root], fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(1);
    projection.invalidate(room, 'b1');
    await projection.previews(room, [root], fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(2);
    projection.reset();
    await projection.previews(room, [root], fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(3);
  });

  it('bounds concurrent reads and backs off a failed thread instead of failing the room', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let active = 0, peak = 0;
    io.threadPage.mockImplementation(async (_room: string, rootId: string) => {
      active += 1; peak = Math.max(peak, active);
      await Promise.resolve(); active -= 1;
      if (rootId.endsWith('0')) throw new Error('offline');
      return [reply(`latest-${rootId}`, rootId)];
    });
    const roots = Array.from({ length: 20 }, (_, i) => message({ id: `30000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, replyCount: 1 }));
    const previews = await projection.previews(room, roots, fullWindow([]));
    expect(peak).toBeLessThanOrEqual(6);
    expect(previews.size).toBe(18);
    io.threadPage.mockClear();
    await projection.previews(room, roots, fullWindow([]));
    expect(io.threadPage).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 31_000);
    await projection.previews(room, roots, fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(2);
  });

  it('ignores replies themselves and roots without replies', async () => {
    const previews = await projection.previews(room, [message({ id: rootA, replyCount: 0 }), reply('nested', rootA, { replyCount: 4 })], fullWindow([]));
    expect(previews.size).toBe(0);
    expect(io.threadPage).not.toHaveBeenCalled();
  });
});

describe('share sources', () => {
  const io = { threadPage: vi.fn(), message: vi.fn() };
  let projection: ReturnType<typeof createThreadProjection<ThreadMessage>>;
  beforeEach(() => { io.threadPage.mockReset(); io.message.mockReset(); projection = createThreadProjection(io); });
  const share = (id: string, messageId: string) => message({ id, content: [buildBotGroupThreadShareCard({ messageId, threadRootId: rootA, authorName: 'Miao', text: 'hi' })] });
  const sourceId = '40000000-0000-4000-8000-000000000001';

  it('prefers fresh snapshot copies and reads each missing reply once', async () => {
    const fresh = reply(sourceId, rootA);
    expect((await projection.shareSources(room, [share('s1', sourceId)], [fresh])).get(sourceId)).toBe(fresh);
    expect(io.message).not.toHaveBeenCalled();
    const other = '40000000-0000-4000-8000-000000000002';
    io.message.mockResolvedValue(reply(other, rootA));
    await projection.shareSources(room, [share('s2', other), share('s3', other)], []);
    await projection.shareSources(room, [share('s2', other)], []);
    expect(io.message).toHaveBeenCalledTimes(1);
  });

  it('remembers a missing reply as unavailable and forgets edited ones', async () => {
    io.message.mockResolvedValue(null);
    expect((await projection.shareSources(room, [share('s1', sourceId)], [])).get(sourceId)).toBeNull();
    io.message.mockResolvedValue(reply(sourceId, rootA, { revision: 2 }));
    projection.invalidate(room, sourceId);
    expect((await projection.shareSources(room, [share('s1', sourceId)], [])).get(sourceId)?.revision).toBe(2);
  });

  it('leaves a share unresolved while the server cannot be reached', async () => {
    io.message.mockRejectedValue(new Error('offline'));
    expect((await projection.shareSources(room, [share('s1', sourceId)], [])).has(sourceId)).toBe(false);
  });

  it('does not treat a card posted inside a thread as a share', async () => {
    const nested = { ...share('s1', sourceId), threadRootId: rootA };
    expect((await projection.shareSources(room, [nested], [])).size).toBe(0);
  });
});

describe('reply summaries', () => {
  it('summarizes text separately from files and refuses system or deleted replies', () => {
    const files = reply('f', rootA, { content: [{ type: 'text', text: '  第一行\n第二行 ' }, { type: 'media', mediaId: 'm1', caption: 'shot.PNG' }, { type: 'media', mediaId: 'm2', caption: 'notes.pdf' }] });
    expect(threadPreviewText(files)).toBe('第一行 第二行');
    expect(threadPreviewAttachments(files)).toEqual([{ name: 'shot.PNG', category: 'image' }, { name: 'notes.pdf', category: 'file' }]);
    expect(threadPreviewText(reply('long', rootA, { content: [{ type: 'text', text: 'x'.repeat(400) }] }))).toHaveLength(280);
    expect(isShareableThreadReply(files)).toBe(true);
    expect(isShareableThreadReply(message({ id: 'root' }))).toBe(false);
    expect(isShareableThreadReply(reply('d', rootA, { deleted: true }))).toBe(false);
    expect(isShareableThreadReply(reply('s', rootA, { origin: 'system' }))).toBe(false);
    expect(isShareableThreadReply(reply('n', rootA, { content: [{ type: 'card', namespace: 'cindy.group-notice', fallback: 'x' }] }))).toBe(false);
  });
});
