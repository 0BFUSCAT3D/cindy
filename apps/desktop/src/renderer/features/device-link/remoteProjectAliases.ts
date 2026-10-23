import {
  createProjectAliasMirror,
  PROJECT_ALIASES_GET_CHANNEL,
  type ProjectAliasesByDevice,
} from '@cindy/maker-shared/project-alias-sync';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { parseSyncedProjectOrderOwnerStamp, type SyncedProjectOrderOwnerStamp } from '@cindy/maker-shared/project-order-sync';

const mirror = createProjectAliasMirror();
const EMPTY: ProjectAliasesByDevice = new Map();
let owner: DataOwnerGeneration | null = null;
const ownerStamps = new Map<string, SyncedProjectOrderOwnerStamp>();

function selectOwner(requestOwner: DataOwnerGeneration): void {
  if (owner && isDataOwnerGenerationCurrent(owner)) return;
  ownerStamps.clear();
  mirror.clear();
  owner = requestOwner;
}

function acceptOwnerStamp(deviceId: string, raw: unknown): boolean {
  const stamp = parseSyncedProjectOrderOwnerStamp(raw);
  if (!stamp || stamp.dataOwnerId !== owner?.dataOwnerId) return false;
  const previous = ownerStamps.get(deviceId);
  if (previous && stamp.ownerGeneration < previous.ownerGeneration) return false;
  ownerStamps.set(deviceId, stamp);
  return true;
}

/** Renderer-only display mirror. Its lifecycle is owned by the existing remote-project synchronizer. */
export const remoteProjectAliases = {
  subscribe: mirror.subscribe,
  getSnapshot: (): ProjectAliasesByDevice =>
    owner && isDataOwnerGenerationCurrent(owner) ? mirror.getSnapshot() : EMPTY,
  clear(): void {
    owner = null;
    ownerStamps.clear();
    mirror.clear();
  },
  remove(deviceId: string): void {
    ownerStamps.delete(deviceId);
    mirror.remove(deviceId);
  },
  suspend(deviceId: string): void {
    ownerStamps.delete(deviceId);
    mirror.suspend(deviceId);
  },
  acceptChanged(deviceId: string, ownerStamp: unknown, localOwnerStamp: unknown, isEligible: () => boolean): boolean {
    const requestOwner = getDataOwnerGeneration();
    if (!requestOwner.dataOwnerId || !isEligible() || !isDataOwnerPushCurrent(localOwnerStamp)) return false;
    selectOwner(requestOwner);
    return acceptOwnerStamp(deviceId, ownerStamp);
  },
  refresh(deviceId: string, isEligible: () => boolean, invalidate = false): Promise<void> {
    const requestOwner = getDataOwnerGeneration();
    if (!requestOwner.dataOwnerId || !isEligible()) return Promise.resolve();
    selectOwner(requestOwner);
    return mirror[invalidate ? 'invalidate' : 'refresh'](
      deviceId,
      () => window.electronAPI.deviceLink.invoke(deviceId, PROJECT_ALIASES_GET_CHANNEL, []),
      (snapshot) => isEligible()
        && isDataOwnerGenerationCurrent(requestOwner)
        && (snapshot === undefined || acceptOwnerStamp(deviceId, snapshot.ownerStamp)),
    );
  },
};
