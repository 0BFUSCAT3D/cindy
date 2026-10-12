import type { InstalledGhost } from '../../shared/ghost.js';
import type { PluginUsageIdentity } from '../../shared/pluginUsage.js';
import type { PluginMarketInstallationRecord } from '../plugin-market/ledger.js';
import {
  verifyInstalledMarketManifest,
  type InstalledMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';

/** Distribution identity and trust labels are independent. Custom public scope stays custom. */
export function pluginUsageIdentity(
  ghost: InstalledGhost,
  record: PluginMarketInstallationRecord | null,
  installedIdentity: InstalledMarketManifestIdentity | null,
  serverRoot: string,
): PluginUsageIdentity | null {
  if (ghost.approval.state !== 'approved') return null;
  const base: PluginUsageIdentity = {
    ghostId: ghost.manifest.id,
    displayName: ghost.manifest.name,
    revision: ghost.approval.revision,
    sourceKind: 'manual',
    stableKey: null,
    pluginId: null,
    organizationId: null,
    sourceKey: null,
    serverRoot: null,
    version: ghost.manifest.version ?? null,
    releaseId: null,
  };
  if (
    !record?.installed ||
    record.ghostId !== base.ghostId ||
    !installedIdentity ||
    !verifyInstalledMarketManifest(record, installedIdentity)
  )
    return base;
  if (record.source === 'git-market' || record.source === 'local-market') {
    if (!record.sourceKey) return base;
    return {
      ...base,
      sourceKind: record.source,
      sourceKey: record.sourceKey,
      stableKey: JSON.stringify([record.source, record.sourceKey, base.ghostId]),
      releaseId: record.releaseId,
    };
  }
  if (!serverRoot) return base;
  return {
    ...base,
    sourceKind: 'server',
    pluginId: record.pluginId,
    organizationId: record.organizationId,
    serverRoot,
    stableKey: JSON.stringify(['server', serverRoot, record.pluginId]),
    releaseId: record.releaseId,
  };
}
