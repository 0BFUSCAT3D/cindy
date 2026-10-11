/**
 * 供应商组的分配(docs/product-rules/provider-groups.md §5、§6)：新任务第一次运行时选一台组内电脑，
 * 之后固定在这台；那台出问题时由 failover 换到下一台。
 *
 * 分配结果写回任务记录(`sessions.agent_device_id` / `provider_id`)：选中别的电脑后，这个任务就是
 * 普通的远程 Agent 任务，复用现有的整条链路，不改协议。
 *
 * 组内电脑的失败记在这里，所有使用方(本机任务、同账号其他电脑、分享的人)共用一份：哪个使用方试出那台不能用，
 * 之后谁选电脑都先避开它，不再每次从不能用的那台开始试(2026-10-11 用户要求)。用量上限的冷却落盘(重启后照样避开)；
 * 其余失败、轮询游标与「这一轮已试过」只在本次运行内有效，重启后按组内电脑的实时状态重新判断。
 */
import { findCatalogModel, isModelSelectableForNewRoute } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import type { AutoResumeAgentSwitchCause } from '../../shared/agentInputQueue.js';
import type { ProviderGroupConfig, ProviderGroupMember, ProviderGroupView } from '../../shared/providerGroup.js';
import type { ProviderGroupBinding } from './bindings.js';
import type { ProviderGroupDirectory, ResolvedMemberState, ResolvedProviderGroupMember } from './directory.js';
import { pickProviderGroupMember, type SchedulableMember } from './scheduler.js';

/** 撞到用量上限但拿不到重置时刻时，默认冷却多久。 */
export const PROVIDER_GROUP_DEFAULT_COOLDOWN_MS = 30 * 60_000;
/** 连不上 / 登录失效等失败后第一次避开多久(同一台再失败时按 PROVIDER_GROUP_FAILURE_BACKOFF_MS 递增)。 */
export const PROVIDER_GROUP_FAILURE_COOLDOWN_MS = 2 * 60_000;
/** 同一台避开期过后再试又失败时，每次避开多久：2、5、15、30、60 分钟，之后都按 60 分钟。 */
export const PROVIDER_GROUP_FAILURE_BACKOFF_MS: readonly number[] = [
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  ...[5, 15, 30, 60].map((m) => m * 60_000),
];
/** 避开期过后多久内，仍把它排在没失败过的电脑后面：组里有别的能用就先不去试它。 */
export const PROVIDER_GROUP_SUSPECT_MS = 30 * 60_000;
/** 多久没再失败，连续失败的次数清零。 */
export const PROVIDER_GROUP_FAILURE_STREAK_RESET_MS = 6 * 60 * 60_000;
/**
 * 选电脑时等组内电脑状态的时间：到点已经有能用的电脑就不再等更慢的那几台(那几台这次按不能用算，读取照常在后台
 * 完成、留在缓存里)；一台能用的都还没有时照旧等全部读完，不会因为慢就误报「都不能用」。
 */
export const PROVIDER_GROUP_PICK_QUICK_MS = 3_000;
/** 组所在电脑自己作为使用方(本机任务、替分享的人中转)的键；同账号其他电脑用它的设备 id。 */
export const PROVIDER_GROUP_LOCAL_REPORTER = '\u0000self';
/**
 * 「这一轮已试过」多久后作废：一轮里每台最多试一次；换过去之后正常跑了一阵再出错，算新的一轮。
 */
export const PROVIDER_GROUP_TURN_WINDOW_MS = 30 * 60_000;

/** 防止异常对端无限占内存的边界，远高于实际同账号电脑数。 */
const MAX_REPORTERS = 256;

export interface ProviderGroupFailureNote {
  cause: AutoResumeAgentSwitchCause;
  /** 用量上限冷却到何时(调用方按重置时刻算好)；不给按默认时长。其余原因忽略。 */
  until?: number | null;
  /** 哪个使用方遇到的；不给 = 组所在电脑自己。 */
  reporter?: string;
  /**
   * 只是这个使用方和那台的连接断了(断线、不响应)：只对它生效——可能只是它连不过去。那台真连不上时，组所在电脑
   * 读它的状态本来就是离线，所有使用方都会避开。
   */
  connectionLost?: boolean;
}

/** 落盘的用量上限冷却：供应商 → 组内电脑 → 冷却到何时(unix ms)。 */
export type ProviderGroupPersistedCooling = Record<string, Record<string, number>>;

export interface ProviderGroupRouterDeps {
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  listBindings(): Record<string, ProviderGroupBinding>;
  /** 这个任务现在是否正在运行一轮。 */
  isTurnRunning(sessionId: string): boolean;
  /**
   * 经本组分出去、但不在本机任务表里的运行中任务(同账号其他电脑报来的、刚选中还没报来的)。
   * 不提供 = 只算本机任务。
   */
  externalRunning?(providerId: string, memberKey: string): number;
  /** 用量上限冷却的落盘位置；不提供 = 只在本次运行内有效。 */
  coolingStore?: {
    read(): ProviderGroupPersistedCooling;
    write(value: ProviderGroupPersistedCooling): void;
  };
  now(): number;
  random(): number;
}

export interface ProviderGroupPickInput {
  providerId: string;
  agentKind: AgentKind;
  model: string;
  exclude?: ReadonlySet<string>;
  /** 替哪个使用方选(只它连不过去的电脑对它避开)；不给 = 组所在电脑自己。 */
  reporter?: string;
  /**
   * 选中后在同一步(读负载与选电脑之间没有等待)调用，用来立即记上占用：同时来的几个请求各自读到前一个的
   * 占用，不会全落到同一台。
   */
  onPicked?(memberKey: string): void;
}

export type ProviderGroupPickResult =
  | { kind: 'none' }
  | { kind: 'member'; member: ProviderGroupMember; label: string; resolved: ResolvedProviderGroupMember[] }
  | { kind: 'unavailable'; resolved: ResolvedProviderGroupMember[] };

export interface ProviderGroupRouter {
  pick(input: ProviderGroupPickInput): Promise<ProviderGroupPickResult>;
  /** `reporter`：按哪个使用方看(只它连不过去的电脑对它显示为刚才没能使用)；不给 = 组所在电脑自己。 */
  view(providerId: string, options?: { reporter?: string }): Promise<ProviderGroupView>;
  /** 经本组分到这台、正在运行的任务数。 */
  running(providerId: string, memberKey: string): number;
  markCooling(providerId: string, memberKey: string, until: number): void;
  /**
   * 记一次这台的失败(§5)：之后所有使用方选电脑都先避开它。用量上限冷却到重置时刻；其余原因(连不上、登录失效、
   * 服务繁忙、Agent 起不来)按同一台连续失败的次数递增避开，那台重新上线或恢复可用时清掉。返回避开到何时。
   */
  noteFailure(providerId: string, memberKey: string, failure: ProviderGroupFailureNote): number;
  /** 这台对这个使用方避开到何时(冷却或刚失败过)；没在避开返回 null。 */
  coolingUntil(providerId: string, memberKey: string, reporter?: string): number | null;
  /** 组里已经知道这台现在用不了(冷却中、刚失败过还在避开期)：确认用不了的不再等它恢复(§6.1)。 */
  isAvoided(providerId: string, memberKey: string, reporter?: string): boolean;
  /**
   * 刚在这台上打开了会话(换过去、启动成功)：它连得上、起得来，清掉这个使用方连不过去的记录与全组的「连不上 / 起不来」
   * 记录。登录失效、服务繁忙不清(打开会话不说明它们好了)，用量上限的冷却也不动。
   */
  noteWorking(providerId: string, memberKey: string, reporter?: string): void;
  /** 记一次「这一轮试过这台」，返回这一轮已试过的全部。 */
  markTried(sessionId: string, memberKey: string): ReadonlySet<string>;
  triedThisTurn(sessionId: string): ReadonlySet<string>;
  /** 这一轮结束(有实质产出、用户接手、放弃换电脑)：下一轮重新从头试。 */
  resetTurn(sessionId: string): void;
}

/** 一台电脑的失败记录：连续失败几次、避开到何时、最近一次失败的时间与原因。 */
interface FailureRecord {
  streak: number;
  until: number;
  at: number;
  cause: AutoResumeAgentSwitchCause;
}

function coolKey(providerId: string, memberKey: string): string {
  return `${providerId}\u0000${memberKey}`;
}

function backoffMs(streak: number): number {
  const steps = PROVIDER_GROUP_FAILURE_BACKOFF_MS;
  return steps[Math.min(streak, steps.length) - 1];
}

export function createProviderGroupRouter(deps: ProviderGroupRouterDeps): ProviderGroupRouter {
  /** 用量上限：冷却到重置时刻。 */
  const cooling = new Map<string, number>();
  /** 其余失败，对所有使用方生效。 */
  const failures = new Map<string, FailureRecord>();
  /** 只是某个使用方连不过去：只对它生效。 */
  const reporterFailures = new Map<string, Map<string, FailureRecord>>();
  /** 上一次读到的组内电脑状态：从不能用变回能用时清掉失败记录。 */
  const lastStates = new Map<string, ResolvedMemberState>();
  const lastPicked = new Map<string, string>();
  const tried = new Map<string, { at: number; keys: Set<string> }>();

  for (const [providerId, members] of Object.entries(readPersistedCooling())) {
    for (const [memberKey, until] of Object.entries(members)) {
      if (until > deps.now()) cooling.set(coolKey(providerId, memberKey), until);
    }
  }

  function readPersistedCooling(): ProviderGroupPersistedCooling {
    try {
      return deps.coolingStore?.read() ?? {};
    } catch {
      return {};
    }
  }

  function persistCooling(): void {
    if (!deps.coolingStore) return;
    const now = deps.now();
    const value: ProviderGroupPersistedCooling = {};
    for (const [key, until] of cooling) {
      if (until <= now) continue;
      const split = key.indexOf('\u0000');
      const providerId = key.slice(0, split);
      (value[providerId] ??= {})[key.slice(split + 1)] = until;
    }
    try {
      deps.coolingStore.write(value);
    } catch {
      // 落盘失败只影响重启后的记忆，本次运行照常避开。
    }
  }

  function currentTried(sessionId: string): Set<string> | null {
    const entry = tried.get(sessionId);
    if (!entry) return null;
    if (deps.now() - entry.at > PROVIDER_GROUP_TURN_WINDOW_MS) {
      tried.delete(sessionId);
      return null;
    }
    return entry.keys;
  }

  function usageCoolingUntil(key: string): number | null {
    const until = cooling.get(key);
    if (until === undefined) return null;
    if (until <= deps.now()) {
      cooling.delete(key);
      return null;
    }
    return until;
  }

  /** 这台对这个使用方的失败记录(全组的与只对它的)；过了清零期的丢掉。 */
  function failureRecords(key: string, reporter: string): FailureRecord[] {
    const now = deps.now();
    const records: FailureRecord[] = [];
    const global = failures.get(key);
    if (global) {
      if (now - global.at > PROVIDER_GROUP_FAILURE_STREAK_RESET_MS) failures.delete(key);
      else records.push(global);
    }
    const own = reporterFailures.get(reporter)?.get(key);
    if (own) {
      if (now - own.at > PROVIDER_GROUP_FAILURE_STREAK_RESET_MS) reporterFailures.get(reporter)!.delete(key);
      else records.push(own);
    }
    return records;
  }

  /** 失败后的避开期还没过：到何时。 */
  function failureUntil(key: string, reporter: string): number | null {
    const now = deps.now();
    let until: number | null = null;
    for (const record of failureRecords(key, reporter)) {
      if (record.until > now && (until === null || record.until > until)) until = record.until;
    }
    return until;
  }

  /** 避开期过了不久(PROVIDER_GROUP_SUSPECT_MS 内)：有没失败过的电脑能用时先不去试它。 */
  function isSuspect(key: string, reporter: string): boolean {
    const now = deps.now();
    return failureRecords(key, reporter).some((record) => record.until <= now && now - record.until < PROVIDER_GROUP_SUSPECT_MS);
  }

  function coolingUntil(providerId: string, memberKey: string, reporter = PROVIDER_GROUP_LOCAL_REPORTER): number | null {
    const key = coolKey(providerId, memberKey);
    const usage = usageCoolingUntil(key);
    const failed = failureUntil(key, reporter);
    if (usage === null) return failed;
    return failed === null ? usage : Math.max(usage, failed);
  }

  /** 同一阵子里的失败(几个任务一起撞上)不重复加码；避开期过后再试又失败才算连续失败多一次。 */
  function nextFailure(previous: FailureRecord | undefined, cause: AutoResumeAgentSwitchCause): FailureRecord {
    const now = deps.now();
    if (previous && previous.until > now) return { ...previous, at: now, cause };
    const streak = previous && now - previous.at <= PROVIDER_GROUP_FAILURE_STREAK_RESET_MS ? previous.streak + 1 : 1;
    return { streak, until: now + backoffMs(streak), at: now, cause };
  }

  function reporterMap(reporter: string): Map<string, FailureRecord> {
    let map = reporterFailures.get(reporter);
    if (map) return map;
    if (reporterFailures.size >= MAX_REPORTERS) {
      // 淘汰最久没有新失败的一个使用方。
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [candidate, records] of reporterFailures) {
        const latest = Math.max(0, ...[...records.values()].map((r) => r.at));
        if (latest < oldestAt) {
          oldestAt = latest;
          oldest = candidate;
        }
      }
      if (oldest !== null) reporterFailures.delete(oldest);
    }
    map = new Map();
    reporterFailures.set(reporter, map);
    return map;
  }

  /** 读到组内电脑的状态：从不能用(离线、供应商关掉等)变回能用说明它恢复了，失败记录清掉。用量上限冷却不受影响。 */
  function observe(providerId: string, resolved: readonly ResolvedProviderGroupMember[]): void {
    for (const r of resolved) {
      if (r.pending) continue;
      const key = coolKey(providerId, r.member.key);
      const previous = lastStates.get(key);
      if (previous !== undefined && previous !== 'ok' && r.state === 'ok') {
        failures.delete(key);
        for (const records of reporterFailures.values()) records.delete(key);
      }
      lastStates.set(key, r.state);
    }
  }

  function running(providerId: string, memberKey: string): number {
    let count = 0;
    for (const [sessionId, binding] of Object.entries(deps.listBindings())) {
      if (binding.providerId === providerId && binding.memberKey === memberKey && deps.isTurnRunning(sessionId)) {
        count++;
      }
    }
    return count + (deps.externalRunning?.(providerId, memberKey) ?? 0);
  }

  /**
   * 分配与设置页共用的运行数。那台实际跑着的数(本机现算、同账号电脑报来那台的总数、分享来的电脑报来本账号
   * 在那里的数，都含不经组直接用的)里已包含经组分过去的，取两者较大的：刚选中、还没开始跑的任务仍按经组的
   * 计数占着；那台较旧报不出时照旧只算经组的。
   */
  function memberRunning(providerId: string, resolved: ResolvedProviderGroupMember): number {
    return Math.max(running(providerId, resolved.member.key), resolved.reportedRunning ?? 0);
  }

  /** 那台能为新会话提供这个模型：停用、已退役、需要付费的都不算(与新建任务、切模型同一准入)。 */
  function offersModel(resolved: ResolvedProviderGroupMember, agentKind: AgentKind, model: string): boolean {
    if (resolved.state !== 'ok' || !resolved.view) return false;
    const found = findCatalogModel(resolved.view, model, agentKind);
    return found !== undefined
      && isModelSelectableForNewRoute(found, { userProvider: resolved.view.source === 'user' });
  }

  return {
    async pick(input) {
      const config = deps.readGroup(input.providerId);
      if (!config) return { kind: 'none' };
      const reporter = input.reporter ?? PROVIDER_GROUP_LOCAL_REPORTER;
      const usable = (r: ResolvedProviderGroupMember) =>
        offersModel(r, input.agentKind, input.model) && coolingUntil(input.providerId, r.member.key, reporter) === null;
      const resolved = await deps.directory.resolveMembers(input.providerId, config, {
        quickMs: PROVIDER_GROUP_PICK_QUICK_MS,
        // 已经有一台没失败过、没满、可以分的电脑：不再等慢的那几台。
        enough: (r) => usable(r)
          && !r.member.paused
          && !input.exclude?.has(r.member.key)
          && !isSuspect(coolKey(input.providerId, r.member.key), reporter)
          && memberRunning(input.providerId, r) < r.member.limit,
      });
      observe(input.providerId, resolved);
      const schedulable: SchedulableMember[] = resolved.map((r) => ({
        key: r.member.key,
        usable: usable(r),
        paused: r.member.paused,
        suspect: isSuspect(coolKey(input.providerId, r.member.key), reporter),
        running: memberRunning(input.providerId, r),
        limit: r.member.limit,
        weight: r.member.weight,
      }));
      const key = pickProviderGroupMember(schedulable, config.strategy, {
        exclude: input.exclude,
        lastPicked: lastPicked.get(input.providerId) ?? null,
        random: deps.random,
      });
      if (!key) return { kind: 'unavailable', resolved };
      lastPicked.set(input.providerId, key);
      input.onPicked?.(key);
      const chosen = resolved.find((r) => r.member.key === key)!;
      return { kind: 'member', member: chosen.member, label: chosen.label, resolved };
    },

    async view(providerId, options) {
      const config = deps.readGroup(providerId);
      if (!config) return { providerId, config: null, members: [] };
      const reporter = options?.reporter ?? PROVIDER_GROUP_LOCAL_REPORTER;
      const resolved = await deps.directory.resolveMembers(providerId, config);
      observe(providerId, resolved);
      return {
        providerId,
        config,
        members: resolved.map((r) => {
          const key = coolKey(providerId, r.member.key);
          const until = coolingUntil(providerId, r.member.key, reporter);
          // 避开期比用量上限的冷却还长(或只有失败记录)：写「刚才没能使用」，不写用量冷却。
          const failed = until !== null && failureUntil(key, reporter) === until;
          const count = memberRunning(providerId, r);
          const state = r.member.paused
            ? 'paused' as const
            : r.state !== 'ok'
              ? r.state
              : until !== null
                ? 'cooling' as const
                : count >= r.member.limit
                  ? 'full' as const
                  : 'available' as const;
          const reason = r.reason ?? (state === 'cooling' && failed ? 'failed' as const : undefined);
          return {
            key: r.member.key,
            kind: r.member.kind,
            label: r.label,
            ...(r.ownerName ? { ownerName: r.ownerName } : {}),
            state,
            ...(reason ? { reason } : {}),
            running: count,
            limit: r.member.limit,
            weight: r.member.weight,
            paused: r.member.paused,
            ...(until !== null ? { coolingUntil: until } : {}),
          };
        }),
      };
    },

    running,

    markCooling(providerId, memberKey, until) {
      const key = coolKey(providerId, memberKey);
      cooling.set(key, Math.max(cooling.get(key) ?? 0, until));
      persistCooling();
    },

    noteFailure(providerId, memberKey, failure) {
      const now = deps.now();
      const key = coolKey(providerId, memberKey);
      if (failure.cause === 'usage-limit') {
        const until = typeof failure.until === 'number' && failure.until > now
          ? failure.until
          : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS;
        cooling.set(key, Math.max(cooling.get(key) ?? 0, until));
        persistCooling();
        return cooling.get(key)!;
      }
      if (failure.connectionLost) {
        const records = reporterMap(failure.reporter ?? PROVIDER_GROUP_LOCAL_REPORTER);
        const record = nextFailure(records.get(key), failure.cause);
        records.set(key, record);
        // 下次选电脑时组所在电脑现读那台：真连不上就是离线，所有使用方都会避开。
        const agentDeviceId = deps.readGroup(providerId)?.members.find((m) => m.key === memberKey)?.agentDeviceId;
        if (agentDeviceId) deps.directory.invalidate(agentDeviceId);
        return record.until;
      }
      const record = nextFailure(failures.get(key), failure.cause);
      failures.set(key, record);
      return record.until;
    },

    coolingUntil,

    isAvoided(providerId, memberKey, reporter) {
      return coolingUntil(providerId, memberKey, reporter) !== null;
    },

    noteWorking(providerId, memberKey, reporter = PROVIDER_GROUP_LOCAL_REPORTER) {
      const key = coolKey(providerId, memberKey);
      reporterFailures.get(reporter)?.delete(key);
      if (failures.get(key)?.cause === 'unavailable') failures.delete(key);
    },

    markTried(sessionId, memberKey) {
      const keys = currentTried(sessionId) ?? new Set<string>();
      keys.add(memberKey);
      tried.set(sessionId, { at: deps.now(), keys });
      return keys;
    },

    triedThisTurn(sessionId) {
      return currentTried(sessionId) ?? new Set<string>();
    },

    resetTurn(sessionId) {
      tried.delete(sessionId);
    },
  };
}
