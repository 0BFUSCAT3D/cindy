import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  listRecycleRecords,
  readRecycleRecord,
  watchRecycleJournal,
  worktreeGeneration,
} from './recycleJournal';
import { recycleManagedWorktree } from './managedRecycle';
import { loadLiveSessionPathKeys } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey } from './resourceLock';
import { subscribeWorktreeRecycleEvents } from './recycleEvents';
import { retryPendingWorktreeRuntimeLeaseReleases } from './runtimeLeases';

import { createWorktreeRecycleMaintenance } from '@cindy/worktree-core/recycleMaintenance';
export type { WorktreeMaintenanceOptions } from '@cindy/worktree-core/recycleMaintenance';
export const {
  WorktreeRecycleMaintenance,
  startWorktreeRecycleMaintenance,
  stopWorktreeRecycleMaintenance,
  auditRegisteredWorktrees,
  isWorktreeRecycleRetrySuspended,
} = createWorktreeRecycleMaintenance({
  store,
  physicalWorktreeKey,
  log: createLogger('worktreeRecycleMaintenance'),
  loadLiveSessionPathKeys,
  recycleManagedWorktree,
  listRecycleRecords,
  readRecycleRecord,
  watchRecycleJournal,
  worktreeGeneration,
  subscribeWorktreeRecycleEvents,
  retryPendingWorktreeRuntimeLeaseReleases,
  userDataRoot: () => app.getPath('userData'),
  getReferenceSource: getDbClient,
});
export type WorktreeRecycleMaintenance = InstanceType<typeof WorktreeRecycleMaintenance>;
