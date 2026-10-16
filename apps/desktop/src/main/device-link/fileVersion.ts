import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

/** Same opened file identity in prepare/open; no raw path or stat fields cross the wire. */
export function fileVersion(absPath: string, stat: Stats): string {
  return createHash('sha256')
    .update(JSON.stringify([absPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
    .digest('hex');
}
