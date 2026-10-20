/** Only a local source read denial warrants file-access recovery guidance.
 * Transport permissions and failures writing another file must keep their own semantics.
 */
export function isSourceFileAccessError(error: unknown, source: string | Buffer): boolean {
  if (typeof source !== 'string' || !error || typeof error !== 'object') return false;
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  return (code === 'EPERM' || code === 'EACCES')
    && path === source
    && (syscall === 'open' || syscall === 'stat' || syscall === 'read');
}
