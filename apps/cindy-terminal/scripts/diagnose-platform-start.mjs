// CI-only diagnostic for a failed native startup. The imported host receives a
// fresh synthetic HOME/profile; no CI account credentials are loaded or printed.
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, 'dist', 'diagnostic-service.mjs');
await build({
  stdin: { contents: "export { TerminalService } from './src/service.ts'; export { TerminalServiceManager } from './src/service-manager.ts';", resolveDir: app },
  outfile: output, platform: 'node', target: 'node22', format: 'esm', bundle: true,
  loader: { '.md': 'text' }, external: ['@roamhq/wrtc', 'better-sqlite3', 'sharp', 'node-pty', 'ssh2'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-start-diagnostic-'));
const home = path.join(temporary, 'home'); await mkdir(home);
const inheritedKeys = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'ci']);
for (const key of Object.keys(process.env)) {
  if (!inheritedKeys.has(key.toLowerCase())) delete process.env[key];
}
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state') });
const { TerminalService, TerminalServiceManager } = await import(pathToFileURL(output).href);
const service = new TerminalService(path.join(temporary, 'profile'));
const manager = new TerminalServiceManager(path.join(temporary, 'profile'), output);
try {
  await service.start(); console.log('ISOLATED_START_OK');
  await manager.install(); console.log('ISOLATED_REGISTRATION_OK');
  await manager.uninstall(); console.log('ISOLATED_UNREGISTRATION_OK');
}
catch (error) {
  // Raw details are confined to this explicit synthetic-profile diagnostic.
  const detail = error => error ? { name: error.name, message: error.message, code: error.code, signal: error.signal, killed: error.killed, syscall: error.syscall, stderr: error.stderr, stack: error.stack, cause: detail(error.cause) } : undefined;
  console.error(JSON.stringify(detail(error), null, 2));
  if (process.platform === 'win32' && error.message === 'SERVICE_REGISTRATION_FAILED') {
    // Diagnose Task Scheduler's text decoder independently; this never converts
    // a failing product acceptance into a pass and contains no real credentials.
    const file=path.join(temporary,'profile','scheduled-service.xml');
    const xml=(await readFile(file,'utf8')).replace('encoding="UTF-8"','encoding="UTF-16"');
    await writeFile(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(xml,'utf16le')]));
    try { await promisify(execFile)('schtasks.exe',['/Create','/TN',manager.id,'/XML',file,'/F'],{timeout:15000}); console.log('UTF16_REGISTRATION_OK'); }
    catch (error) { console.error('UTF16_REGISTRATION_FAILED',JSON.stringify(detail(error))); }
    finally { await promisify(execFile)('schtasks.exe',['/Delete','/TN',manager.id,'/F'],{timeout:15000}).catch(()=>{}); }
  }
  process.exitCode = 1;
} finally {
  await manager.uninstall().catch(() => {});
  await service.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
