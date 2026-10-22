import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';

/** Advanced opt-in, per Cindy owner; contains no native Agent account information. */
export const agentAdapterSettings = createOverrideSettingsFile({
  filePath: () => ownerScopedUserDataPath('agent-adapters.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { enabled: false },
  normalize: (raw) => ({
    enabled: !!raw && typeof raw === 'object' && (raw as { enabled?: unknown }).enabled === true,
  }),
  log: createLogger('agent-adapters:settings'),
  label: 'agent-adapters',
  preserveUnreadableFile: true,
  maxBytes: 4096,
  logLoadedValue: false,
  logReadErrorDetails: false,
});
export function agentAdaptersEnabled(): boolean {
  agentAdapterSettings.invalidateIfChanged();
  return agentAdapterSettings.read().enabled;
}
