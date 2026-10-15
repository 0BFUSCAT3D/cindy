import * as fs from 'node:fs';
import * as path from 'node:path';

/** Only call on the disposable package copy, after native rebuild has finished. */
export function prunePackagedRuntime(buildPath: string): void {
  const modules = path.join(buildPath, 'node_modules');
  // bindings loads build/Release/better_sqlite3.node. Keep the addon and its JS
  // loader; source and compiler intermediates are needed only during rebuild.
  const sqlite = path.join(modules, 'better-sqlite3');
  for (const relative of [
    'deps',
    'src',
    path.join('build', 'Release', 'obj'),
    path.join('build', 'Release', 'obj.target'),
    path.join('build', 'Release', 'sqlite3.a'),
  ]) {
    fs.rmSync(path.join(sqlite, relative), { recursive: true, force: true });
  }
  // The externalized Node entry is excel.js -> lib/exceljs.nodejs.js. dist
  // contains browser/ES5 bundles and maps, not files used by that entry.
  fs.rmSync(path.join(modules, 'exceljs', 'dist'), { recursive: true, force: true });
}
