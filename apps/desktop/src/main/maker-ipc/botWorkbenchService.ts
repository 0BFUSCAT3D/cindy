import { BrowserWindow } from 'electron';
import { createBotWorkbenchStore } from '@cindy/companion-core/workbench';
import { isWindowsPathLike, normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { botProfileDir } from './botProfileFolder.js';
import { MAKER_PUSH } from './channels.js';
import { createLogger } from '../logger.js';
export { normalizeWorkbench } from '@cindy/companion-core/workbench';
const log = createLogger('bot-workbench');
/** Links refer to individual directories, not the repository's sidebar grouping. */
export function linkedProjectDirectoryKey(directory: string): string {
  const normalized = normalizeWorkingDirForStorage(directory) ?? directory;
  return process.platform === 'win32' && isWindowsPathLike(normalized) ? normalized.toLowerCase() : normalized;
}

export const { readBotLinkedProjects, setBotLinkedProject, readLegacyWorkbenchJudgments, readCompanionWorkbench, mergeCompanionWorkbench } = createBotWorkbenchStore({
  profileDir: botProfileDir, directoryKey: linkedProjectDirectoryKey,
  changed: broadcastBotWorkbenchChanged, logger: log,
});
export function broadcastBotWorkbenchChanged(botId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_WORKBENCH_CHANGED, { botId });
    } catch (error) {
      log.warn('Bot workbench broadcast failed', { error: String(error) });
    }
  }
}
