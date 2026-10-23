/**
 * process-monitor/session-label —— 资源监视器 agent 条目的任务标题解析。
 *
 * 标题存在本地库（utility-process 异步 transport）里，而采样每 2s 一轮；
 * 逐轮直查会变成常驻 DB 轮询，这里按 session id 做 TTL 缓存。查不到
 * （任务已删 / 库暂不可读，getSessionRowSnapshot 自吞错返 null）同样入缓存，
 * 让下一轮采样不再重复付出一次往返；缓存只丢标题，不影响 CPU / 内存。
 */

import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';

export const SESSION_LABEL_TTL_MS = 30_000;
/** 活跃 agent 进程数远小于此；触顶整表清空，避免长期驻留陈旧 id。 */
const CACHE_LIMIT = 128;

export interface SessionLabelResolverDeps {
  now?: () => number;
  ttlMs?: number;
}

export function createSessionLabelResolver(
  deps: SessionLabelResolverDeps = {},
): (sessionId: string) => Promise<string | null> {
  const ttlMs = deps.ttlMs ?? SESSION_LABEL_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { label: string | null; atMs: number }>();
  return async (sessionId) => {
    const atMs = now();
    const hit = cache.get(sessionId);
    if (hit && atMs - hit.atMs < ttlMs) return hit.label;
    const row = await getSessionRowSnapshot(sessionId);
    const label = row?.title ?? null;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(sessionId, { label, atMs });
    return label;
  };
}
