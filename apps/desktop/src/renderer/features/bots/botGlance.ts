/**
 * 工作台「一眼」的数据：只读宿主算好的 glance 投影（shared/botAutonomy.ts），渲染层不再自己
 * 聚合任务、例行任务、待办或产出。
 *
 * - 本机伙伴：`localDb.bots.autonomy.glance(botId)`，收到 `onBotAutonomyChanged` 后重读。
 * - 别的电脑上的伙伴：经 device-link 向那台电脑读同一投影，收到那台推来的同名变化后重读；
 *   行上的电脑按「从这台看」改写（那台的本机任务记成那台电脑，记成本机的就是这台）。
 */
import { useEffect, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { BOT_AUTONOMY_IPC, type BotGlance, type GlanceRow } from '../../../shared/botAutonomy';

export interface GlanceState {
  glance: BotGlance | null;
  /** 读取失败（宿主不支持、电脑离线或读取出错）。 */
  failed: boolean;
  /** 最近一次读到的时刻；行上的分钟数按它往后推，不必每分钟重读。 */
  fetchedAt: number;
}

export interface GlanceHost {
  /** 伙伴所在电脑；null = 这台。 */
  deviceId: string | null;
  deviceName?: string | null;
  /** 这台电脑在 device-link 里的 id，用来把远端记成「别的电脑」的行认回本机。 */
  selfDeviceId?: string | null;
}

/** 远程任务的 sessionId 带 `deviceId::` 前缀；导航与交互要用那台电脑上的裸 id。 */
export function bareGlanceSessionId(row: Pick<GlanceRow, 'sessionId' | 'deviceId'>): string {
  const prefix = row.deviceId ? `${row.deviceId}::` : null;
  if (prefix && row.sessionId.startsWith(prefix)) return row.sessionId.slice(prefix.length);
  const split = row.sessionId.indexOf('::');
  return split > 0 ? row.sessionId.slice(split + 2) : row.sessionId;
}

function rebaseRow(row: GlanceRow, host: GlanceHost): GlanceRow {
  if (!host.deviceId) return row;
  const bare = bareGlanceSessionId(row);
  if (!row.deviceId) {
    // 那台的本机任务：从这台看就是那台电脑上的任务。
    return { ...row, deviceId: host.deviceId, deviceName: host.deviceName ?? row.deviceName, sessionId: `${host.deviceId}::${bare}` };
  }
  if (host.selfDeviceId && row.deviceId === host.selfDeviceId) {
    return { ...row, deviceId: null, deviceName: null, online: true, sessionId: bare };
  }
  return row;
}

export function rebaseGlance(glance: BotGlance, host: GlanceHost): BotGlance {
  if (!host.deviceId) return glance;
  return {
    ...glance,
    waiting: glance.waiting.map((row) => rebaseRow(row, host)),
    working: glance.working.map((row) => rebaseRow(row, host)),
  };
}

function readGlance(botId: string, hostDeviceId: string | null): Promise<BotGlance> {
  if (hostDeviceId) {
    return window.electronAPI.deviceLink.invoke(hostDeviceId, BOT_AUTONOMY_IPC.glance, [botId]) as Promise<BotGlance>;
  }
  const api = window.electronAPI?.localDb?.bots?.autonomy;
  if (!api) return Promise.reject(new Error('Bot autonomy is not available'));
  return api.glance(botId);
}

function subscribeGlance(botId: string, hostDeviceId: string | null, onChange: () => void): () => void {
  if (hostDeviceId) {
    return window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
      if (push.deviceId !== hostDeviceId || push.channel !== BOT_AUTONOMY_IPC.changed) return;
      if (!isDeviceLinkRemotePushCurrent(push, stamp)) return;
      const ids = (push.payload as { botIds?: unknown } | null)?.botIds;
      if (!Array.isArray(ids) || ids.includes(botId)) onChange();
    });
  }
  return (
    window.electronAPI?.maker?.onBotAutonomyChanged?.((payload) => {
      if (!payload?.botIds || payload.botIds.includes(botId)) onChange();
    }) ?? (() => {})
  );
}

/** 一位伙伴的 glance；`enabled = false` 时不读不订阅（例如还没确认任务归属）。 */
export function useBotGlance(botId: string, host: GlanceHost, enabled = true): GlanceState {
  const hostDeviceId = host.deviceId;
  const [state, setState] = useState<GlanceState>({ glance: null, failed: false, fetchedAt: 0 });
  useEffect(() => {
    setState({ glance: null, failed: false, fetchedAt: 0 });
    if (!enabled || !botId) return;
    let alive = true;
    let request = 0;
    const owner = getDataOwnerGeneration();
    const load = () => {
      const current = ++request;
      readGlance(botId, hostDeviceId)
        .then((glance) => {
          if (!alive || current !== request || !isDataOwnerGenerationCurrent(owner)) return;
          setState({ glance, failed: false, fetchedAt: Date.now() });
        })
        .catch(() => {
          if (!alive || current !== request || !isDataOwnerGenerationCurrent(owner)) return;
          // 保留上一份已读到的内容，只标记这次没读到。
          setState((previous) => ({ ...previous, failed: true }));
        });
    };
    load();
    const off = subscribeGlance(botId, hostDeviceId, load);
    return () => {
      alive = false;
      off();
    };
  }, [botId, enabled, hostDeviceId]);
  return state;
}

export type AllowOutcome = 'allowed' | 'gone' | 'blocked' | 'failed';

/**
 * 「允许」：只回应这一行对应的那条权限请求，本机走本机宿主，别的电脑走 device-link 隧道到那台。
 * 请求已经不在（被处理、被换掉）时不替主人批准别的请求，交给调用方改为「去任务里看」。
 */
export async function allowGlanceRow(row: GlanceRow): Promise<AllowOutcome> {
  if (row.deviceId && !row.online) return 'blocked';
  const sessionId = bareGlanceSessionId(row);
  const api = row.deviceId
    ? (await import('@/lib/makerTransport')).makerApiForDevice(row.deviceId)
    : window.electronAPI.maker;
  const pending = await api.getPendingInteractions(sessionId);
  const permissions = (Array.isArray(pending) ? pending : []).filter((item) => item?.request?.kind === 'permission');
  const target = row.requestId
    ? permissions.find((item) => item.request.requestId === row.requestId)
    : permissions.length === 1 ? permissions[0] : undefined;
  if (!target) return 'gone';
  const receipt = await api.resolveInteraction(target.request.requestId, { kind: 'permission', behavior: 'allow' });
  return receipt?.accepted === true ? 'allowed' : 'failed';
}
