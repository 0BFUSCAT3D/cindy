/**
 * 归档前的自动化提醒:绑定到已归档任务的自动化在下次触发时会被调度器暂停(持续会话
 * 除外,它会换绑新任务继续跑),归档入口据此升级到确认弹窗,让用户先知道。本机读
 * schedulesStore,远程任务读 remoteProjectsStore 的绑定分片;读取失败按「无绑定」处理。
 */
import type { TFunction } from 'i18next';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

import { buildBindingMap, type ScheduleBinding } from './scheduleBindingIndex';
import { schedulesStore } from './schedulesStore';

export interface ArchiveTarget {
  id: string;
  deviceLinkDeviceId?: string | null;
}

/** 每个任务归档后会停掉的自动化名称(active、非持续会话);没有的任务不出现在结果里。 */
export async function loadActiveBoundScheduleNames(
  targets: readonly ArchiveTarget[],
): Promise<Map<string, string[]>> {
  const needsLocal = targets.some((target) => !target.deviceLinkDeviceId);
  const localSchedules = needsLocal
    ? await schedulesStore.ensure().catch(() => schedulesStore.getSnapshot())
    : null;
  const localMap: ReadonlyMap<string, readonly ScheduleBinding[]> = localSchedules
    ? buildBindingMap(localSchedules)
    : new Map();
  const result = new Map<string, string[]>();
  for (const target of targets) {
    const bindings = target.deviceLinkDeviceId
      ? remoteProjectsStore.getSessionScheduleBindings(target.deviceLinkDeviceId, target.id)
      : (localMap.get(target.id) ?? []);
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
