/**
 * 测试价值
 * - 生产入口与可观察结果:createTaskDigestReader 交给 get_task_digest 的摘要(本机 / 另一台电脑 / 不存在)。
 * - 规则依据:摘要优先用观察层状态行(与工作台、事件同一口径),缺行时保守推断;子项失败不拖垮整份;
 *   跨电脑不给换模型建议(set_session_runtime 只支持本机);离线电脑明确报 REMOTE_UNAVAILABLE。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:有 / 无观察层状态行的本机任务;PR 读取抛错;离线电脑;已删除任务。
 * - tier:unit(依赖全部注入,无数据库、Electron 与网络)。
 */
import { describe, expect, it, vi } from 'vitest';

import type { WatchedSession } from '../../../shared/botAutonomy.js';
import { createTaskDigestReader, formatPrStatuses, sessionFactsFromRow, type TaskDigestDeps } from '../taskDigest.js';

const NOW = Date.UTC(2026, 9, 17, 6, 0, 0);
const route = { harness: 'codex' as const, model: 'gpt-5.5', provider_id: 'openai', effort: 'high', fast: false };

function setup(watched: Record<string, WatchedSession> = {}) {
  const deps: TaskDigestDeps = {
    now: () => NOW,
    watched: (key) => watched[key] ?? null,
    local: {
      readSession: async (id) => (id === 'gone' ? { title: 'x', status: 'deleted', route: null } : id === 'local-1' ? { title: '修登录', status: 'active', route } : null),
      readActivity: async () => ({ phase: 'needs-interaction', interactionKind: 'permission', lastActivityAtMs: NOW - 9 * 60_000, runtimeGeneration: 4, route }),
      readLastExchange: async () => ({ lastUserAsk: '修登录', lastAssistantLine: '要删旧表吗?' }),
      queuedCount: async () => 2,
      prStatus: async () => { throw new Error('gh offline'); },
      suggestRoute: vi.fn(async () => ({ ...route, harness: 'claude-code' as const, model: 'claude-opus-5-5' })),
    },
    remote: {
      deviceName: async () => 'MacBook',
      readSession: async (deviceId) => {
        if (deviceId === 'offline') throw new Error('DEVICE_OFFLINE');
        return { title: '跑测试', status: 'active', route };
      },
      readActivity: async () => ({ phase: 'running' }),
      readLastExchange: async () => ({ lastUserAsk: '跑一遍', lastAssistantLine: null }),
      prStatus: async () => 'PR o/r#3 open',
    },
  };
  return { read: createTaskDigestReader(deps), deps };
}

describe('task digest assembly', () => {
  it('builds a local digest, inferring the phase when the watcher has no row and surviving a failed PR read', async () => {
    const { read, deps } = setup();
    const result = await read({ sessionId: 'local-1', callerSessionId: 'bot-main' });
    expect(result).toEqual({
      ok: true,
      digest: {
        session_id: 'local-1', device: null, title: '修登录', phase: 'waiting-permission', elapsed_minutes: 9,
        last_user_ask: '修登录', last_assistant_line: '要删旧表吗?', pending_question: null, error: null,
        current_route: route, runtime_generation: 4,
        suggested_route: { ...route, harness: 'claude-code', model: 'claude-opus-5-5' },
        pr_status: null, queued_count: 2, follower_bot_id: null, creator_bot_id: null,
      },
    });
    expect(deps.local.suggestRoute).toHaveBeenCalledWith({ callerSessionId: 'bot-main', targetSessionId: 'local-1', current: route });
  });

  it('prefers the watcher row for phase, question, error and who follows', async () => {
    const row = {
      sessionId: 'local-1', deviceId: null, deviceName: null, online: true, title: '修登录(状态表)', workingDir: null,
      phase: 'usage-limit', phaseSince: NOW - 30 * 60_000, lastActivityAt: NOW, startedAt: null,
      pendingQuestion: null, error: '已达用量上限', creatorBotId: 'writer', followerBotId: 'writer', source: 'user',
    } satisfies WatchedSession;
    const result = await setup({ 'local-1': row }).read({ sessionId: 'local-1' });
    expect(result).toMatchObject({
      ok: true,
      digest: { title: '修登录(状态表)', phase: 'usage-limit', elapsed_minutes: 30, error: '已达用量上限', creator_bot_id: 'writer', follower_bot_id: 'writer' },
    });
  });

  it('reads another computer without a route suggestion, and reports offline or missing tasks explicitly', async () => {
    const { read } = setup();
    expect(await read({ sessionId: 'laptop::s-1', callerSessionId: 'bot-main' })).toMatchObject({
      ok: true,
      digest: { session_id: 'laptop::s-1', device: 'MacBook', phase: 'running', pr_status: 'PR o/r#3 open', suggested_route: null, runtime_generation: null, queued_count: null },
    });
    expect(await read({ sessionId: 'offline::s-1' })).toMatchObject({ ok: false, errorCode: 'REMOTE_UNAVAILABLE' });
    expect(await read({ sessionId: 'gone' })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await read({ sessionId: 'nope' })).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await read({ sessionId: 'a::b::c' })).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('turns stored session rows and PR results into the digest vocabulary', () => {
    expect(sessionFactsFromRow({ title: 't', status: 'active', agentKind: 'cc', model: 'claude-opus-5-5', providerId: null, effort: 'max', fastMode: true }))
      .toEqual({ title: 't', status: 'active', route: { harness: 'claude-code', model: 'claude-opus-5-5', provider_id: null, effort: 'max', fast: true } });
    expect(formatPrStatuses([
      { ok: true, prNumber: 12, repo: 'cindy', status: 'open', unresolvedCount: 3 },
      { ok: false, prNumber: 9, repo: 'cindy' },
    ])).toBe('PR cindy#12 open,3 条评审未解决;PR cindy#9 状态未知');
    expect(formatPrStatuses([])).toBeNull();
  });
});
