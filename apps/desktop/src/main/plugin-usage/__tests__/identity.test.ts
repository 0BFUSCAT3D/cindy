import { expect, it } from 'vitest';
import { pluginUsageIdentity } from '../identity';
import type { InstalledGhost } from '../../../shared/ghost';
import type { PluginMarketInstallationRecord } from '../../plugin-market/ledger';
import type { InstalledMarketManifestIdentity } from '../../plugin-market/installedManifestIdentity';
const ghost = {
  manifest: { id: 'some-plugin', name: 'Official text is not an identity', version: '1.0' },
  approval: { state: 'approved', revision: 'rev1' },
} as InstalledGhost;
const snapshot = {
  manifest: ghost.manifest,
  rawManifestSha256: 'exact',
  legacyManifestDigest: 'legacy',
  legacyManifestDigests: ['legacy'],
} as InstalledMarketManifestIdentity;
const record = {
  pluginId: 'plugin1',
  ghostId: 'some-plugin',
  releaseId: 'r1',
  version: '1.0',
  sha256: 'package',
  scope: 'public',
  organizationId: null,
  source: 'market',
  installed: true,
  updatedAt: '2026-10-12',
  rawManifestSha256: 'exact',
} as PluginMarketInstallationRecord;
it('requires a verified active market installation; names and public fields are not evidence', () => {
  expect(pluginUsageIdentity(ghost, null, snapshot, 'https://server')?.sourceKind).toBe('manual');
  expect(
    pluginUsageIdentity(
      ghost,
      { ...record, rawManifestSha256: 'different' },
      snapshot,
      'https://server',
    )?.stableKey,
  ).toBeNull();
  expect(
    pluginUsageIdentity(ghost, { ...record, installed: false }, snapshot, 'https://server')
      ?.stableKey,
  ).toBeNull();
  expect(
    pluginUsageIdentity(
      { ...ghost, approval: { state: 'legacy-unapproved' } },
      record,
      snapshot,
      'https://server',
    ),
  ).toBeNull();
});
it('separates identical plugin ids from distinct server roots and preserves custom public distribution', () => {
  const a = pluginUsageIdentity(ghost, record, snapshot, 'https://one')!;
  expect(a.stableKey).not.toBe(
    pluginUsageIdentity(ghost, record, snapshot, 'https://two')?.stableKey,
  );
  expect(
    pluginUsageIdentity(
      ghost,
      { ...record, source: 'git-market', sourceKey: 'git:one' },
      snapshot,
      'https://one',
    ),
  ).toMatchObject({ sourceKind: 'git-market', serverRoot: null, pluginId: null });
  expect(
    pluginUsageIdentity(ghost, { ...record, source: 'git-market' }, snapshot, 'https://one')
      ?.stableKey,
  ).toBeNull();
});
