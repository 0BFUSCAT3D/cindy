import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { filterCindyMakeSharedTasks } from '@cindy/maker-shared/cindy-make-feature';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import type { useDeviceLink } from './DeviceLinkContext';

export function filterVisibleSharedTasks(
  tasks: readonly SharedTaskListItem[],
  ownerAccountId: string | null,
  link: Pick<ReturnType<typeof useDeviceLink>, 'openLink' | 'invoke'>,
  isCurrent: () => boolean,
) {
  const deviceId = (task: SharedTaskListItem) => task.ownerAccountId === ownerAccountId
    ? task.hostDeviceId : sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  return filterCindyMakeSharedTasks(tasks, {
    isCurrent,
    knownSession: task => remoteSessionStore.getSessions().find(session =>
      session.id === task.sessionId && session.deviceLinkDeviceId === deviceId(task)),
    readSession: async task => {
      const peer = deviceId(task);
      if (task.ownerAccountId !== ownerAccountId) {
        await link.openLink(peer);
        if (!isCurrent()) return null;
      }
      return link.invoke<RemoteSession | null>(peer, 'local-db:sessions:get', [task.sessionId]);
    },
  });
}
