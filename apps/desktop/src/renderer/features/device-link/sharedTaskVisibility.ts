import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { filterCindyMakeSharedTasks } from '@cindy/maker-shared/cindy-make-feature';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { remoteProjectsStore } from './remoteProjectsStore';

export function filterVisibleSharedTasks<Task extends SharedTaskListItem & { local?: boolean }>(
  tasks: readonly Task[],
  isCurrent: () => boolean,
) {
  const owner = getDataOwnerGeneration();
  const deviceId = (task: Task) => task.ownerAccountId === owner.dataOwnerId
    ? task.hostDeviceId : sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  return filterCindyMakeSharedTasks(tasks, {
    isCurrent,
    knownSession: task => task.local
      ? sessionsStore.findById(task.sessionId)
      : remoteProjectsStore.getDeviceSessions(deviceId(task)).find(session => session.id === task.sessionId),
    readSession: async task => {
      if (task.local) return sessionService.get(task.sessionId);
      const peer = deviceId(task);
      if (task.ownerAccountId !== owner.dataOwnerId) {
        await window.electronAPI.deviceLink.openLink(peer);
        if (!isCurrent()) return null;
      }
      return window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [task.sessionId]) as Promise<Session>;
    },
  });
}
