import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { READ_SHEET_RUNTIME_PACKAGES } from '../../../../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps';

const desktopRoot = path.resolve(process.cwd());
const execFileAsync = promisify(execFile);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  const dispose = cleanup;
  cleanup = undefined;
  await dispose?.();
});

describe('read_sheet XLSX worker packaging contract', () => {
  it('copies the worker runtime dependency closures into packaged node_modules', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(READ_SHEET_RUNTIME_PACKAGES).toEqual(['jszip', 'exceljs']);
    expect(forge).toContain('copyRuntimeDependencyTrees(READ_SHEET_RUNTIME_PACKAGES, destModules)');
    expect(forge).toContain('copyRuntimeTrees(deps, destModules, resolvePackageDir)');
  });

  it('loads ExcelJS and JSZip from an isolated staged dependency tree', async () => {
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-read-sheet-package-'));
    const abort = new AbortController();
    const pending = execFileAsync(process.execPath, [
      '--experimental-strip-types',
      path.join(desktopRoot, 'scripts/fixtures/read-sheet-runtime-probe.mjs'),
      temp,
    ], { cwd: temp, encoding: 'utf8', signal: abort.signal, timeout: 120_000, windowsHide: true });
    const closed = new Promise<void>((resolve) => pending.child.once('close', () => resolve()));
    cleanup = async () => {
      abort.abort();
      await pending.catch(() => undefined);
      await closed;
      await fs.promises.rm(temp, { recursive: true, force: true });
    };
    const probe = await pending; // Nonzero exits reject, including runtime import failures.
    expect(fs.existsSync(path.join(temp, 'node_modules', 'exceljs', 'dist'))).toBe(false);
    expect(probe.stdout).toBe('ok');
    // CI #6973: synchronous staging/cleanup blocked Vitest RPC for >60s on
    // Windows. Keep the real dependency closure and original 120s test budget;
    // yield during staging and clean up in the separately bounded lifecycle hook.
  }, 120_000);
});
