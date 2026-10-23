import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { createSourceFileAccessError, isSourceFileAccessError } from './sourceFileError';

interface SourceFileAccessRecovery {
  /** A native single-file picker; the selected path stays inside Main. */
  selectFile(source: string): Promise<string | null>;
  assertCurrent(): void;
}
const recoveryContext = new AsyncLocalStorage<SourceFileAccessRecovery & { attempted: Set<string> }>();

/** Only the trusted foreground chat adapter installs this scope. Exports/background jobs do not prompt. */
export function withSourceFileAccessRecovery<T>(recovery: SourceFileAccessRecovery, operation: () => Promise<T>): Promise<T> {
  return recoveryContext.run({ ...recovery, attempted: new Set() }, operation);
}

export async function readWithSourceFileAccessRecovery<T>(source: string, read: () => Promise<T>): Promise<T> {
  const scope = recoveryContext.getStore();
  scope?.assertCurrent();
  try {
    const result = await read();
    scope?.assertCurrent();
    return result;
  } catch (error) {
    if (!scope || !isSourceFileAccessError(error, source)
      || !path.isAbsolute(source) || scope.attempted.has(source)) throw error;
    scope.assertCurrent();
    scope.attempted.add(source);
    const selected = await scope.selectFile(source);
    scope.assertCurrent();
    // Confirm only this original. A different file must never silently replace a draft attachment.
    if (!selected || selected !== source) throw createSourceFileAccessError();
    // No recursive retry: a second denial returns the normal error and restores the draft.
    const result = await read();
    scope.assertCurrent();
    return result;
  }
}
