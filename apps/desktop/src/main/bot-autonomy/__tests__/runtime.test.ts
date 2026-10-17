/*
 * 测试价值
 * - 生产入口与可观察结果：BotAutonomyRuntime（start / evaluate / stop）接真实 RoutineEngine：事件源登记、
 *   内置「跟进」规则落地、阈值事件只叫醒跟进者自己的规则、跟进规则被暂停时改为系统提醒主人、
 *   条件兜底 sweep 只叫醒还有待处理任务且久未被叫醒的伙伴。
 * - Bug／规则依据：docs/product-rules/bot-routines.md「宿主内置事件源 host:sessions」（引擎每次创建后都要
 *   重新登记，事件源表只在内存）与「内置跟进例行任务」；cindy-bots-runtime.md §6.3「没人跟 → 系统提醒」
 *   与「条件兜底」（没有待处理任务的伙伴不被白叫醒）。
 * - 现有覆盖缺口：maker-scheduler 测试只覆盖引擎自身；autonomyRules / taskWatch 不经过引擎，测不到重建后
 *   事件源丢失、followerBotId 过滤与 accepted=0 的提醒分支。
 * - 最小失败输入：引擎重建后不重登记 → publish 抛 "not listening"；waiting 事件叫醒了非跟进者；
 *   跟进规则暂停后主人收不到提醒或被重复提醒；没有待处理任务也被兜底叫醒，或每 30 秒扫描重复叫醒。
 * - tier：unit（真实引擎 + 内存 load/save；状态表 IO 为内存 fake；时间由 now() 推进）。
 */
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { RoutineEngine, type RoutineEngineDeps, type RoutineState } from '@cindy/maker-scheduler';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTONOMY_THRESHOLDS,
  HOST_SESSIONS_SOURCE_ID,
  builtinFollowUpRoutineId,
} from '../../../shared/botAutonomy.js';
import { BotAutonomyRuntime } from '../runtime.js';
import { TaskWatch, type LocalSessionMeta } from '../taskWatch.js';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function meta(id: string): LocalSessionMeta {
  return {
    id, title: `title ${id}`, workingDir: null, status: 'active', hiddenAt: null, source: 'desktop',
    orcaRole: null, laneRole: null, interrupted: false, activeTurnStartedAt: null,
  };
}

function waiting(sessionId: string): SessionActivitySnapshot {
  return {
    sessionId, phase: 'needs-interaction', interactionKind: 'ask_user_question', startedAtMs: 1, lastActivityAtMs: 1,
    currentActionSummary: null, attention: true, workflow: null, turnGeneration: 1, gracefulStopState: 'none', source: 'local',
  } as unknown as SessionActivitySnapshot;
}

async function setup() {
  let now = 1_000_000;
  let saved: RoutineState | null = null;
  const execute = vi.fn<RoutineEngineDeps['execute']>(async () => ({}));
  const remind = vi.fn();
  const engineDeps: RoutineEngineDeps = {
    load: async () => structuredClone(saved),
    save: async (state) => { saved = structuredClone(state); },
    execute,
    id: () => `id-${Math.random().toString(36).slice(2)}`,
    now: () => now,
    changed: () => {},
    onError: () => {},
  };
  const bots = new Map([
    ['sched', { status: 'active', allowSchedulerFollow: false }],
    ['a', { status: 'active', allowSchedulerFollow: false }],
    ['paused-bot', { status: 'paused', allowSchedulerFollow: false }],
  ]);
  const runtime = async (engine: RoutineEngine) => {
    const instance = new BotAutonomyRuntime({
      engine,
      now: () => now,
      log,
      isCurrent: () => true,
      remind,
      push: () => {},
      subscribeActivity: () => () => {},
      createWatch: (onChange) => new TaskWatch({
        now: () => now,
        log,
        onChange,
        getActivitySnapshots: () => [],
        getPendingInteractions: () => [],
        readLocalSessions: async (ids) => ids.map(meta),
        readInterruptedSessions: async () => [],
        readOwnership: async () => ({ bots, creatorBySession: new Map(), responsibleByBot: new Map() }),
        readSchedulerOverride: () => ({ customized: true, schedulerBotId: 'sched' }),
        listRemoteDevices: async () => null,
        invokeRemote: async () => { throw new Error('unused'); },
      }),
    });
    await instance.start({ timers: false });
    return instance;
  };
  const engine = async () => {
    const created = new RoutineEngine(engineDeps);
    await created.start();
    return created;
  };
  return { runtime, engine, execute, remind, advance: (ms: number) => { now += ms; } };
}

describe('BotAutonomyRuntime with the routine engine', () => {
  it('re-registers the host source after an engine rebuild and keeps one built-in rule per active teammate', async () => {
    const t = await setup();
    const first = await t.engine();
    const r1 = await t.runtime(first);
    expect(first.listSources().map((s) => [s.id, s.status])).toEqual([[HOST_SESSIONS_SOURCE_ID, 'listening']]);
    const created = first.list('sched')[0];
    expect(created).toMatchObject({ id: builtinFollowUpRoutineId('sched'), builtin: 'follow-up', silentWhenIdle: true });
    expect(first.list('a')).toHaveLength(1);
    expect(first.list('paused-bot')).toEqual([]);
    r1.stop();
    await first.stop();

    // 账号内重建引擎：事件源表是内存的，新运行体必须重新登记；内置规则幂等，不重复建、不改 revision。
    const second = await t.engine();
    expect(second.listSources()).toEqual([]);
    const r2 = await t.runtime(second);
    expect(second.listSources().map((s) => s.id)).toEqual([HOST_SESSIONS_SOURCE_ID]);
    expect(second.list('sched')).toEqual([created]);
    r2.stop();
    await second.stop();
  });

  it('wakes only the follower for a waiting task and reminds the owner once when its rule is paused', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    try {
      runtime.watch.applyActivity('t1', waiting('t1'));
      await runtime.watch.settled();
      await runtime.evaluate();
      expect(t.execute).not.toHaveBeenCalled();

      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('sched'));
      expect(run.events.map((e) => [e.sourceId, e.event.type, e.event.data.followerBotId, e.event.subject])).toEqual([
        [HOST_SESSIONS_SOURCE_ID, 'waiting', 'sched', 't1'],
      ]);
      expect(t.remind).not.toHaveBeenCalled();

      // 主人暂停了总调度的跟进规则：事件没人接 → 本机任务改为系统提醒，同一事件只提醒一次。
      await engine.put('sched', { ...engine.list('sched')[0]!, enabled: false }, builtinFollowUpRoutineId('sched'));
      runtime.watch.applyActivity('t2', waiting('t2'));
      await runtime.watch.settled();
      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await runtime.evaluate();
      expect(t.remind).toHaveBeenCalledTimes(1);
      expect(t.remind.mock.calls[0]![0]).toMatchObject({ sessionId: 't2', followerBotId: 'sched' });
      expect(t.execute).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });

  it('sweeps a follower only when it has pending tasks and has not been woken for a fallback interval', async () => {
    const t = await setup();
    const engine = await t.engine();
    const runtime = await t.runtime(engine);
    const interval = AUTONOMY_THRESHOLDS.fallbackIntervalMs;
    try {
      // 没有待处理任务：满兜底间隔也不叫醒。
      t.advance(interval);
      await runtime.evaluateFallback();
      expect(t.execute).not.toHaveBeenCalled();

      // 有一条等你的任务、且距启动（视为上次叫醒）已满间隔 → 发一条 sweep；30 秒扫描再来也不重复。
      runtime.watch.applyActivity('t1', waiting('t1'));
      await runtime.watch.settled();
      await runtime.evaluateFallback();
      await runtime.evaluateFallback();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(1));
      const [routine, run] = t.execute.mock.calls[0]!;
      expect(routine.id).toBe(builtinFollowUpRoutineId('sched'));
      expect(run.events.map((e) => [e.event.type, e.event.subject, e.event.data.sessionId, e.event.data.followerBotId])).toEqual([
        ['sweep', 'sched', '', 'sched'],
      ]);

      // 普通事件叫醒也算「被叫醒」：之后要再满一个间隔才兜底。
      t.advance(AUTONOMY_THRESHOLDS.waitingAfterMs);
      await runtime.evaluate();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(2));
      t.advance(interval - 1);
      await runtime.evaluateFallback();
      expect(t.execute).toHaveBeenCalledTimes(2);
      t.advance(1);
      await runtime.evaluateFallback();
      await vi.waitFor(() => expect(t.execute).toHaveBeenCalledTimes(3));
      expect(t.execute.mock.calls[2]![1].events.map((e) => e.event.type)).toEqual(['sweep']);
      expect(engine.list('a')[0]!.triggers.some((trigger) => trigger.kind === 'interval')).toBe(false);
    } finally {
      runtime.stop();
      await engine.stop();
    }
  });
});
