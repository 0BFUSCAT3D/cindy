/** Only a local source read denial warrants file-access recovery guidance.
 * Transport permissions and failures writing another file must keep their own semantics.
 */
export function isSourceFileAccessError(error: unknown, source: string | Buffer): boolean {
  if (typeof source !== 'string' || !error || typeof error !== 'object') return false;
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  return (code === 'EPERM' || code === 'EACCES')
    && path === source
    && (syscall === 'open' || syscall === 'stat' || syscall === 'fstat' || syscall === 'read');
}

/** Use only around stat/read on a handle opened from this source, never around transport work. */
export async function withSourceFileHandleContext<T>(
  source: string | Buffer,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (typeof source === 'string' && error && typeof error === 'object') {
      const { code, syscall, path } = error as NodeJS.ErrnoException;
      // Node's fd-based failures omit path. Do not overwrite a different explicit path or
      // reinterpret a write/network failure just because it carries the same errno.
      if (path === undefined && (code === 'EPERM' || code === 'EACCES')
        && (syscall === 'fstat' || syscall === 'read')) {
        throw Object.assign(new Error('Source attachment access denied', { cause: error }), {
          code, syscall, path: source,
        });
      }
    }
    throw error;
  }
}
