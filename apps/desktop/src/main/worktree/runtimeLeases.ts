import { app } from 'electron';

import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';

import { notifyWorktreeRecycleOpportunity } from './recycleEvents';

import { isReusedDesktopInstancePid, readDesktopProcessIdentity } from '../desktopProcessIdentity';

import { isGitProcessTreeAlive } from './gitExec';
import { createWorktreeRuntimeLeases } from '@cindy/worktree-core/runtimeLeases';
const service = createWorktreeRuntimeLeases({
  physicalWorktreeKey,
  withWorktreeResourceLock,
  notifyWorktreeRecycleOpportunity,
  readDesktopProcessIdentity,
  isReusedDesktopInstancePid,
  isGitProcessTreeAlive: (pid) => isGitProcessTreeAlive(pid),
  userDataRoot: () => app.getPath('userData'),
  appDataRoot: () => app.getPath('appData'),
});
export const {
  managedWorktreeRoot,
  acquireWorktreeRuntimeLease,
  releaseWorktreeRuntimeLease,
  recordWorktreeRuntimeLeaseChild,
  retryPendingWorktreeRuntimeLeaseReleases,
  readWorktreeRuntimePaths,
  reclaimOrphanedWorktreeRuntimeLeases,
} = service;
export type { WorktreeRuntimeLease } from '@cindy/worktree-core/runtimeLeases';
