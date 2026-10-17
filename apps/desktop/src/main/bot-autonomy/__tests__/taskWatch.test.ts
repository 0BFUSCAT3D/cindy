/*
 * 测试价值
 * - 生产入口与可观察结果：TaskWatch（start / applyActivity / applyInputProjection / sweep）产出的状态表行：
 *   哪些任务进表、处于什么状态、等你的那句话、谁在跟；远程电脑失败时的退避与离线标记。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md §6.3（观察范围：排除伙伴专线 / 隐藏 / Orca
 *   worker；启动时已做完的任务不补发；远程电脑离线保留最后状态；轮询失败退避，不形成重试风暴）。
 * - 现有覆盖缺口：新模块；autonomyRules 只测纯判定，不经过活动订阅、读库与远程轮询的组合时序。
 * - 最小失败输入：伙伴主任务（canonical）出现在活动里；启动时灵动岛残留「完成」；远程 list-active 连续失败。
 * - tier：unit（全部 IO 经注入的内存 fake，时间由 now() 推进，无真实等待）。
 */
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { describe, expect, it, vi } from 'vitest';

import { AUTONOMY_THRESHOLDS } from '../../../shared/botAutonomy.js';
import {
  REMOTE_BACKOFF_MAX_MS,
  TaskWatch,
  type LocalSessionMeta,
  type RemoteDeviceTarget,
  type TaskWatchDeps,
} from '../taskWatch.js';

function meta(id: string, patch: Partial<LocalSessionMeta> = {}): LocalSessionMeta {
  return {
    id, title: `title ${id}`, workingDir: '/w', status: 'active', hiddenAt: null, source: 'desktop',
    orcaRole: null, laneRole: null, interrupted: false, activeTurnStartedAt: null, ...patch,
  };
}

function activity(sessionId: string, phase: string, extra: Partial<SessionActivitySnapshot> = {}): SessionActivitySnapshot {
  return {
    sessionId, phase, startedAtMs: 1_000, lastActivityAtMs: 1_000, currentActionSummary: null,
    attention: false, workflow: null, turnGeneration: 1, gracefulStopState: 'none', source: 'local', ...extra,
  } as unknown as SessionActivitySnapshot;
}

function harness(options: {
  metas?: LocalSessionMeta[];
  snapshots?: SessionActivitySnapshot[];
  devices?: RemoteDeviceTarget[] | null;
  invokeRemote?: TaskWatchDeps['invokeRemote'];
  creators?: Record<string, string>;
} = {}) {
  let now = 10_000;
  const metas = new Map((options.metas ?? []).map((m) => [m.id, m]));
  const pending = new Map<string, unknown[]>();
  const onChange = vi.fn();
  const invokeRemote = vi.fn(options.invokeRemote ?? (async () => { throw new Error('offline'); }));
  const watch = new TaskWatch({
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    getActivitySnapshots: () => options.snapshots ?? [],
    getPendingInteractions: (id) => pending.get(id) ?? [],
    readLocalSessions: async (ids) => ids.flatMap((id) => (metas.has(id) ? [metas.get(id)!] : [])),
    readInterruptedSessions: async () => [...metas.values()].filter((m) => m.interrupted),
    readOwnership: async () => ({
      bots: new Map([['sched', { status: 'active', allowSchedulerFollow: false }], ['a', { status: 'active', allowSchedulerFollow: false }]]),
      creatorBySession: new Map(Object.entries(options.creators ?? {})),
      responsibleByBot: new Map(),
    }),
    readSchedulerOverride: () => ({ customized: true, schedulerBotId: 'sched' }),
    listRemoteDevices: async () => options.devices ?? null,
    invokeRemote,
    onChange,
  });
  return {
    watch, metas, pending, onChange, invokeRemote,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

describe('TaskWatch local observation', () => {
  it('tracks user and teammate tasks, skips teammate lanes, and ignores a completion seen only at startup', async () => {
    const h = harness({
      metas: [
        meta('user'), meta('delegated'), meta('lane', { laneRole: 'canonical', source: 'bot' }),
        meta('hidden', { hiddenAt: 1 }), meta('worker', { orcaRole: 'worker' }), meta('stale-done'),
        meta('crashed', { interrupted: true, activeTurnStartedAt: 5_000 }),
      ],
      snapshots: [activity('stale-done', 'completed')],
      creators: { delegated: 'a' },
    });
    await h.watch.start();
    // 启动兜底：上次没收尾的任务按出错进表；启动时已完成的任务不补「做完」。
    expect(h.watch.list().map((r) => [r.sessionId, r.phase, r.phaseSince, r.followerBotId])).toEqual([
      ['crashed', 'errored', 5_000, 'sched'],
    ]);

    for (const id of ['user', 'delegated', 'lane', 'hidden', 'worker']) h.watch.applyActivity(id, activity(id, 'running'));
    await h.watch.settled();
    expect(h.watch.list().map((r) => [r.sessionId, r.source, r.followerBotId]).sort()).toEqual([
      ['crashed', 'user', 'sched'],
      ['delegated', 'bot-task', 'a'],
      ['user', 'user', 'sched'],
    ]);

    // 等权限：带一句话摘要与请求 id，不带工具入参。
    h.pending.set('user', [{ kind: 'permission', requestId: 'req-9', toolName: 'Bash', input: { command: 'secret' } }]);
    h.watch.applyActivity('user', activity('user', 'needs-interaction', { interactionKind: 'permission' }));
    // 用量上限：协调器投影优先于活动相位。
    h.watch.applyInputProjection({ sessionId: 'delegated', error: 'limit', usageLimitWait: { resumeAt: 1 } });
    await h.watch.settled();
    expect(h.watch.get('user')).toMatchObject({ phase: 'waiting-permission', pendingQuestion: 'Bash', pendingRequestId: 'req-9' });
    expect(JSON.stringify(h.watch.get('user'))).not.toContain('secret');
    expect(h.watch.get('delegated')?.phase).toBe('usage-limit');

    // 跑完后活动条目消失：算一次「做完」，计入今天做完。
    h.watch.applyActivity('user', null);
    await h.watch.settled();
    expect(h.watch.get('user')?.phase).toBe('finished');
    expect(h.watch.finished().map((f) => f.sessionId)).toEqual(['user']);
  });
});

describe('TaskWatch remote polling', () => {
  it('reads eligible online computers, then backs off and marks rows offline when polling fails', async () => {
    let fail = false;
    const h = harness({
      devices: [
        { deviceId: 'dev-1', name: 'Studio', online: true, eligible: true },
        { deviceId: 'dev-2', name: 'Locked', online: true, eligible: false },
      ],
      invokeRemote: async (_deviceId, channel) => {
        if (fail) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        if (channel === 'maker:list-active') {
          return { format: 'active-sessions-v2', sessions: [
            { sessionId: 'r1', isTurnRunning: true, activityPhase: 'running' },
            { sessionId: 'r2', isTurnRunning: true, activityPhase: 'running' },
          ] };
        }
        if (channel === 'local-db:sessions:get-many') {
          return [
            { id: 'r1', title: 'Remote build', source: 'desktop', status: 'active', hiddenAt: null, updatedAt: 9_000, messageCount: 3 },
            // 那台电脑伙伴自己的任务由那台电脑的伙伴跟，不跨电脑重复跟。
            { id: 'r2', title: 'Teammate lane', source: 'bot', status: 'active', hiddenAt: null },
          ];
        }
        return [];
      },
    });
    await h.watch.start();
    await h.watch.sweep();
    expect(h.watch.list().map((r) => [r.sessionId, r.deviceName, r.phase, r.followerBotId, r.online])).toEqual([
      // 另一台电脑上的任务只进工作台：跟进者恒为 null，由那台电脑上的伙伴跟，避免同名伙伴各跟一遍。
      ['dev-1::r1', 'Studio', 'running', null, true],
    ]);
    expect(h.invokeRemote.mock.calls.every(([deviceId]) => deviceId === 'dev-1')).toBe(true);

    fail = true;
    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.sweep();
    expect(h.watch.get('dev-1::r1')?.online).toBe(false);
    expect(h.watch.offlineDevices()).toEqual(['Studio']);

    // 退避期内不再请求那台电脑；退避有上限。
    const calls = h.invokeRemote.mock.calls.length;
    h.advance(AUTONOMY_THRESHOLDS.remotePollMs);
    await h.watch.sweep();
    expect(h.invokeRemote.mock.calls.length).toBe(calls);
    h.advance(REMOTE_BACKOFF_MAX_MS);
    await h.watch.sweep();
    expect(h.invokeRemote.mock.calls.length).toBe(calls + 1);
  });
});
