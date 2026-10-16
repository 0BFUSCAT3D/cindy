import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

/** Same opened file identity in prepare/open; no raw path or stat fields cross the wire. */
export function fileVersion(absPath: string, stat: Stats, versionedCache = false): string {
  // SSH cache paths already encode owner/endpoint/workdir/path + remote size/mtime.
  // Those copies are immutable; local mtime/ctime are touched solely for LRU.
  return createHash('sha256')
    .update(
      JSON.stringify(
        versionedCache
          ? [absPath, stat.size]
          : [absPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs],
      ),
    )
    .digest('hex');
}
