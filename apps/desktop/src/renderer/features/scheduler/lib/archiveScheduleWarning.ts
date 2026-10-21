/**
 * 归档前的自动化提醒:绑定到已归档任务的自动化在下次触发时会被调度器暂停(持续会话
 * 除外,它会换绑新任务继续跑),归档入口据此升级到确认弹窗,让用户先知道。本机读
 * schedulesStore,远程任务读 remoteProjectsStore 的绑定分片;读取失败按「无绑定」处理。
 */
import type { Schedule } from '@cindy/maker-scheduler';
import type { TFunction } from 'i18next';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

import {
  buildBindingMap,
  parseScheduleBindings,
  type ScheduleBinding,
} from './scheduleBindingIndex';
import { schedulesStore } from './schedulesStore';

export interface ArchiveTarget {
  id: string;
  deviceLinkDeviceId?: string | null;
}

/** 冷启动且缓存未就绪时,最多等这么久;超时按「无绑定」处理,不让普通任务的归档卡在列表请求上。 */
export const COLD_SCHEDULE_LOAD_WAIT_MS = 1500;

/**
 * 本机列表:缓存存在且没有刷新在途时直接用(侧栏行常驻订阅,通常已就绪);缓存缺失,或有刷新在途
 * (缓存可能刚被创建 / 恢复 / 改绑作废)时,有限等待那次请求,超时退回已有缓存(没有则当无绑定)。
 */
async function readLocalSchedules() {
  const cached = schedulesStore.getSnapshot();
  const pending = schedulesStore.pendingRefresh() ?? (cached ? null : schedulesStore.ensure());
  if (!pending) return cached;
  const timeout = new Promise<Schedule[] | null>((resolve) =>
    setTimeout(() => resolve(cached), COLD_SCHEDULE_LOAD_WAIT_MS),
  );
  return Promise.race([pending.catch(() => cached), timeout]);
}

/**
 * 远程设备的绑定快照尚未加载(刚连上或重连后首拉还在途)时,空结果不是权威的:
 * 直接取一次绑定列表,最多等 COLD_SCHEDULE_LOAD_WAIT_MS,失败或超时按「无绑定」处理。
 */
async function readRemoteBindingsOnce(
  deviceId: string,
): Promise<readonly ScheduleBinding[] | null> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), COLD_SCHEDULE_LOAD_WAIT_MS),
  );
  const load = window.electronAPI.deviceLink
    .invoke(deviceId, 'maker:schedule:list', [null, { sessionBindings: true }])
    .then(parseScheduleBindings)
    .catch(() => null);
  return Promise.race([load, timeout]);
}

/** 每个任务归档后会停掉的自动化名称(active、非持续会话);没有的任务不出现在结果里。 */
export async function loadActiveBoundScheduleNames(
  targets: readonly ArchiveTarget[],
): Promise<Map<string, string[]>> {
  // 本机与各台冷远程设备的读取同时发起,共用一个等待窗口(混合设备批量归档不会叠加到 2 倍)。
  const needsLocal = targets.some((target) => !target.deviceLinkDeviceId);
  const localRead = needsLocal ? readLocalSchedules() : null;
  // 快照未就绪的远程设备,每台只直接取一次。
  const coldRemote = new Map<string, Promise<ReadonlyMap<string, ScheduleBinding[]> | null>>();
  for (const target of targets) {
    const deviceId = target.deviceLinkDeviceId;
    if (
      deviceId &&
      !remoteProjectsStore.hasScheduleBindings(deviceId) &&
      !coldRemote.has(deviceId)
    ) {
      coldRemote.set(
        deviceId,
        readRemoteBindingsOnce(deviceId).then((list) => (list ? buildBindingMap(list) : null)),
      );
    }
  }
  const localSchedules = localRead ? await localRead : null;
  const localMap: ReadonlyMap<string, readonly ScheduleBinding[]> = localSchedules
    ? buildBindingMap(localSchedules)
    : new Map();
  const result = new Map<string, string[]>();
  for (const target of targets) {
    const deviceId = target.deviceLinkDeviceId;
    let bindings: readonly ScheduleBinding[];
    if (!deviceId) bindings = localMap.get(target.id) ?? [];
    else if (remoteProjectsStore.hasScheduleBindings(deviceId))
      bindings = remoteProjectsStore.getSessionScheduleBindings(deviceId, target.id);
    else bindings = (await coldRemote.get(deviceId))?.get(target.id) ?? [];
    const names = bindings
      .filter((schedule) => schedule.status === 'active' && !schedule.persistentSession)
      .map((schedule) => schedule.name);
    if (names.length > 0) result.set(target.id, names);
  }
  return result;
}

/** 单个任务的提醒句;无绑定时返回空串。 */
export function archiveScheduleWarning(t: TFunction, names: readonly string[]): string {
  if (names.length === 0) return '';
  return t('ccAgent.sidebar.confirmArchive.scheduleWarning', {
    count: names.length,
    names: names
      .map((name) => t('ccAgent.sidebar.confirmArchive.scheduleName', { name }))
      .join(t('ccAgent.sidebar.confirmArchive.scheduleNameSeparator')),
  });
}

/** 批量归档的提醒句:绑定了 active 自动化的任务数;为 0 时返回空串。 */
export async function archiveScheduleWarningMany(
  t: TFunction,
  targets: readonly ArchiveTarget[],
): Promise<string> {
  const count = (await loadActiveBoundScheduleNames(targets)).size;
  return count > 0 ? t('ccAgent.sidebar.confirmArchive.scheduleWarningMany', { count }) : '';
}

/** 单个任务归档确认的完整说明:基础句 + worktree 警告 + 自动化提醒。 */
export function archiveConfirmDescription(
  t: TFunction,
  { dirtyWorktree, scheduleNames }: { dirtyWorktree: boolean; scheduleNames: readonly string[] },
): string {
  return [
    t('ccAgent.sidebar.confirmArchive.description'),
    dirtyWorktree ? t('ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning') : '',
    archiveScheduleWarning(t, scheduleNames),
  ]
    .filter(Boolean)
    .join(' ');
}
