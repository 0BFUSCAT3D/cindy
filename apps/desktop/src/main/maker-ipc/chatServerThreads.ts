/**
 * Thread previews and main-chat shares for the Chat Server adapter.
 *
 * Previews: the room snapshot already carries the newest 100 messages of every thread,
 * so active threads cost no extra request. Only a root whose newest replies are older
 * than that window reads a bounded page of its own, cached until its reply count changes
 * or one of those replies is edited or deleted.
 *
 * Shares: a share card only names a reply. Its author, text and files always come from
 * the server's copy of that reply, which the server checks against this reader's access.
 */
import { BOT_GROUP_THREAD_PREVIEW_REPLIES, readBotGroupThreadShareCard } from '../../shared/botGroupChat.js';

export interface ThreadMessage {
  id: string; seq: string; authorId: string; deleted: boolean; threadRootId: string | null;
  origin?: string; replyCount?: number; revision?: number;
  content: Array<{ type: string; text?: string; fallback?: string; namespace?: string; schemaRevision?: number; data?: Record<string, unknown>; mediaId?: string; caption?: string }>;
}

/** Concurrent reads per refresh; the rest wait for a slot rather than fan out. */
const READ_CONCURRENCY = 6;
/** A failed read is retried on a later refresh, not on every push. */
const RETRY_MS = 30_000;
/** Deleted replies still occupy a page, so read a little more than the preview needs. */
const FALLBACK_PAGE = BOT_GROUP_THREAD_PREVIEW_REPLIES + 4;
const SNAPSHOT_WINDOW = 100;

async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

export function createThreadProjection<M extends ThreadMessage>(io: {
  /** Newest-first page of one thread. */
  threadPage(roomId: string, rootId: string, limit: number): Promise<M[]>;
  /** One message as this reader may see it; `null` when the server says it does not exist. */
  message(roomId: string, messageId: string): Promise<M | null>;
}) {
  const previews = new Map<string, { replyCount: number; replies: M[] }>();
  const sources = new Map<string, M | null>();
  const retryAt = new Map<string, number>();
  const key = (roomId: string, id: string) => `${roomId}:${id}`;
  const waiting = (cacheKey: string) => (retryAt.get(cacheKey) ?? 0) > Date.now();

  return {
    /**
     * Newest replies of every root in `page`, chronological. `snapshot` is the server's
     * newest-first window across the main chat and all threads.
     */
    async previews(roomId: string, page: readonly M[], snapshot: readonly M[]): Promise<Map<string, M[]>> {
      const complete = snapshot.length < SNAPSHOT_WINDOW;
      const inWindow = new Map<string, M[]>();
      for (const message of snapshot) {
        if (!message.threadRootId || message.deleted) continue;
        const list = inWindow.get(message.threadRootId) ?? [];
        list.push(message); inWindow.set(message.threadRootId, list);
      }
      const result = new Map<string, M[]>();
      const missing: M[] = [];
      for (const root of page) {
        const count = root.replyCount ?? 0;
        if (root.threadRootId || count <= 0) continue;
        const found = inWindow.get(root.id) ?? [];
        const cached = previews.get(key(roomId, root.id));
        // The window is a suffix of the room's sequence, so what it holds is the newest.
        if (complete || found.length >= Math.min(count, BOT_GROUP_THREAD_PREVIEW_REPLIES)) result.set(root.id, found);
        else if (cached?.replyCount === count) result.set(root.id, cached.replies);
        else if (!waiting(key(roomId, root.id))) missing.push(root);
      }
      await eachLimited(missing, async root => {
        const cacheKey = key(roomId, root.id);
        try {
          const replies = (await io.threadPage(roomId, root.id, FALLBACK_PAGE)).filter(message => !message.deleted);
          previews.set(cacheKey, { replyCount: root.replyCount ?? 0, replies });
          retryAt.delete(cacheKey);
          result.set(root.id, replies);
        } catch { retryAt.set(cacheKey, Date.now() + RETRY_MS); }
      });
      for (const [rootId, replies] of result)
        result.set(rootId, replies.slice(0, BOT_GROUP_THREAD_PREVIEW_REPLIES).reverse());
      return result;
    },
    /**
     * The replies named by share cards in `page`: a message, `null` when it no longer
     * exists for this reader, or absent while the server cannot be reached.
     */
    async shareSources(roomId: string, page: readonly M[], known: readonly M[]): Promise<Map<string, M | null>> {
      const fresh = new Map(known.map(message => [message.id, message]));
      const result = new Map<string, M | null>();
      const missing = new Set<string>();
      for (const message of page) {
        const card = readBotGroupThreadShareCard(message);
        if (!card || result.has(card.messageId)) continue;
        const cacheKey = key(roomId, card.messageId);
        if (fresh.has(card.messageId)) result.set(card.messageId, fresh.get(card.messageId)!);
        else if (sources.has(cacheKey)) result.set(card.messageId, sources.get(cacheKey)!);
        else if (!waiting(cacheKey)) missing.add(card.messageId);
      }
      await eachLimited([...missing], async messageId => {
        const cacheKey = key(roomId, messageId);
        try {
          const value = await io.message(roomId, messageId);
          sources.set(cacheKey, value); retryAt.delete(cacheKey);
          result.set(messageId, value);
        } catch { retryAt.set(cacheKey, Date.now() + RETRY_MS); }
      });
      return result;
    },
    /** An edited or deleted message may be a cached reply or share source. */
    invalidate(roomId: string, messageId: string) {
      sources.delete(key(roomId, messageId));
      for (const [cacheKey, entry] of previews)
        if (cacheKey.startsWith(`${roomId}:`) && entry.replies.some(reply => reply.id === messageId)) previews.delete(cacheKey);
    },
    /** Pushes may have been missed while disconnected. */
    reset() { previews.clear(); sources.clear(); retryAt.clear(); },
  };
}

/** A reply that can stand for itself in the main chat. */
export function isShareableThreadReply(message: ThreadMessage): boolean {
  return !!message.threadRootId && !message.deleted && message.origin !== 'system'
    && !message.content.some(block => block.namespace === 'cindy.group-notice' || block.namespace === 'cindy.local-history');
}

/** Reply text for a one-line preview; files are listed separately. */
export function threadPreviewText(message: ThreadMessage): string {
  return message.content.flatMap(block => block.type === 'media' ? [] : [block.text ?? block.fallback ?? '']).join(' ')
    .replace(/\s+/g, ' ').trim().slice(0, 280);
}

export function threadPreviewAttachments(message: ThreadMessage) {
  return message.content.flatMap(block => block.type === 'media' && block.mediaId ? [{
    name: block.caption ?? '',
    category: /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)$/i.test(block.caption ?? '') ? 'image' as const : 'file' as const,
  }] : []);
}
