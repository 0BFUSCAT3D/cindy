import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_COUNT = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

const BLOCKED_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);

function isInside(parent: string, child: string): boolean {
  const fold = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBlockedFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  const sensitiveDirectory = filePath
    .split(/[\\/]+/)
    .some((segment) => ['.git', '.ssh'].includes(segment.toLowerCase()));
  return BLOCKED_FILE_NAMES.has(name)
    || name.startsWith('.env.')
    || name.endsWith('.key')
    || sensitiveDirectory;
}

/** Output files may not exist yet: validate their nearest existing ancestor.
 * Reuse the upload roots and sensitive-file policy, including symlink identity. */
export function resolveRecipeOutputPath(candidate: string, allowedRoots: string[]): string {
  const roots = allowedRoots.flatMap((root) => {
    if (!path.isAbsolute(root)) return [];
    try {
      const real = fs.realpathSync(root);
      return fs.statSync(real).isDirectory() ? [real] : [];
    } catch { return []; }
  });
  if (!roots.length) throw new Error('recipe output requires a local session directory');
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error('recipe output must be a local file path');
  }
  const target = path.resolve(roots[0], candidate);
  if (isBlockedFile(target)) throw new Error('recipe output blocked for sensitive path');
  let ancestor = target;
  const tail: string[] = [];
  while (true) {
    try {
      // lstat distinguishes missing paths from broken links, which grant nothing.
      fs.lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    const real = fs.realpathSync(ancestor);
    const resolved = path.join(real, ...tail);
    if (!roots.some((root) => isInside(root, resolved))) {
      throw new Error('recipe output must stay inside the current session directory');
    }
    if (isBlockedFile(resolved)) throw new Error('recipe output blocked for sensitive path');
    return resolved;
  }
}

/**
 * Resolves upload candidates to their filesystem identity and confines every
 * file to a host-provided root. Realpath checks prevent a workdir symlink or
 * junction from granting access to a file outside that workdir.
 */
export async function resolveUploadFiles(
  candidates: unknown,
  allowedRoots: string[],
): Promise<string[]> {
  return resolveUploadFilesSync(candidates, allowedRoots);
}

/** Synchronous adapters share exactly the same file policy as native uploads. */
export function resolveUploadFilesSync(candidates: unknown, allowedRoots: string[]): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('paths must contain at least one file');
  }
  if (candidates.length > MAX_FILE_COUNT) {
    throw new Error(`paths accepts at most ${MAX_FILE_COUNT} files`);
  }

  const roots: string[] = [];
  for (const root of allowedRoots) {
    if (!path.isAbsolute(root)) continue;
    try {
      const resolved = fs.realpathSync(root);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) roots.push(resolved);
    } catch {
      // A missing optional root grants nothing.
    }
  }
  if (roots.length === 0) {
    throw new Error('upload is unavailable without a local session directory');
  }

  const files: string[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new Error('every upload path must be an absolute local file path');
    }
    let resolved: string;
    let stat;
    try {
      resolved = fs.realpathSync(candidate);
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`upload file does not exist: ${path.basename(candidate) || 'unnamed'}`);
    }
    if (!stat.isFile()) {
      throw new Error(`upload path is not a regular file: ${path.basename(resolved)}`);
    }
    if (!roots.some((root) => isInside(root, resolved))) {
      throw new Error('upload files must stay inside the current session directory');
    }
    if (isBlockedFile(resolved)) {
      throw new Error(`upload blocked for sensitive file: ${path.basename(resolved)}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`upload file exceeds ${MAX_FILE_BYTES} bytes: ${path.basename(resolved)}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`upload batch exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    files.push(resolved);
  }
  return files;
}
