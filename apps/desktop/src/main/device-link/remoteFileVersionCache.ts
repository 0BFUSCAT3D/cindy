import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { validFileVersion, type DeviceFileResult } from '@cindy/device-link';
import { getActiveAppSession } from '../appSessionState';
import { getDbClient } from '../localDb/client/current';
import {
  integrationCacheGet,
  integrationCachePut,
  supportedMime,
} from '../cindy-media/integrationCache';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime';
import { scanCache, evictCacheBlobs, CACHE_LIMIT_BYTES } from '../cindy-media/recycler';
import {
  readVersionedRemoteFile,
  removeVersionedRemoteFile,
  writeVersionedRemoteFile,
} from '../file-browser/remote-file-cache';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { removeRefs } from '../cindy-media/ledger';

const INTEGRATION = 'remote-file';
export type FileVersionMetadata = Pick<DeviceFileResult, 'version' | 'size' | 'mimeType'> & {
  skipCache?: boolean;
};

/** An adapter to the existing media warehouse / ordinary-file LRU, not another byte store.
 * Authorization and stat happen on the host before this adapter is called, every time.
 * Generations guard in-flight work; stable owner IDs key the durable cache across restarts. */
export function remoteFileVersionCache(
  device: string,
  url: string,
  metadata?: FileVersionMetadata,
) {
  if (!metadata || !validFileVersion(metadata.version)) return null;
  const owner = captureDataOwnerBroadcastScope();
  const session = getActiveAppSession();
  if (!session.dataOwnerId || !isDataOwnerBroadcastScopeCurrent(owner)) return null;
  const { version, size, mimeType } = metadata;
  const source = createHash('sha256')
    .update(JSON.stringify([session.mode, session.dataOwnerId, device, url]))
    .digest('hex');
  const key = `${INTEGRATION}:${source}:${version}`;
  const media = /^(image|audio|video|model)\//.test(mimeType);
  const db = media ? getDbClient().drizzle : undefined;
  const assertCurrent = () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
  };
  return {
    async invalidate(): Promise<void> {
      assertCurrent();
      if (!media) return removeVersionedRemoteFile(source, version);
      const hit = await integrationCacheGet(key, db);
      assertCurrent();
      if (hit)
        await evictCacheBlobs(
          {
            hashes: [hit.hash],
            live: new Set(),
            integration: INTEGRATION,
            assertStillValid: assertCurrent,
          },
          db,
        );
      // Shared/pinned bytes survive the conditional eviction; remove only our index.
      assertCurrent();
      await removeRefs({ refKind: 'integration-cache', refId: key }, db);
    },
    async get(): Promise<string | null> {
      assertCurrent();
      if (!media) {
        const file = await readVersionedRemoteFile(source, version, size);
        assertCurrent();
        return file;
      }
      const hit = await integrationCacheGet(key, db);
      assertCurrent();
      if (!hit) return null;
      const stat = await fs.lstat(hit.absPath).catch(() => null);
      assertCurrent();
      return stat?.isFile() && stat.size === size ? hit.absPath : null;
    },
    async put(file: string): Promise<void> {
      assertCurrent();
      if (!media) return writeVersionedRemoteFile(source, version, file, size, assertCurrent);
      // A copy that cannot fit the existing cache budget would evict everything
      // else and immediately be evicted itself. It remains available to its consumer.
      if (size > CACHE_LIMIT_BYTES) return;
      // Bounded sniff; never load a large media file into main-process memory.
      const handle = await fs.open(file, 'r');
      let verified: string | null;
      try {
        const probe = Buffer.alloc(Math.min(size, 4096));
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        verified = sniffMediaMime(probe.subarray(0, bytesRead), mimeType);
      } finally {
        await handle.close();
      }
      assertCurrent();
      if (!verified || !supportedMime(verified)) return;
      const written = await integrationCachePut(
        {
          cacheKey: key,
          integration: INTEGRATION,
          filePath: file,
          mimeType: verified,
          assertStillValid: assertCurrent,
        },
        db,
      );
      assertCurrent();
      // Use the warehouse's existing byte budget. Only this integration's cache
      // is eligible: attachments, pinned media and other integrations stay protected.
      const live = new Set([written.hash]);
      const scan = await scanCache({ live, integration: INTEGRATION }, db);
      assertCurrent();
      await evictCacheBlobs(
        {
          hashes: scan.evictable.map((entry) => entry.hash),
          live,
          integration: INTEGRATION,
          assertStillValid: assertCurrent,
        },
        db,
      );
    },
  };
}
