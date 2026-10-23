// CI-only diagnostic for a failed native startup. The imported host receives a
// fresh synthetic HOME/profile; no CI account credentials are loaded or printed.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-start-diagnostic-'));
const home = path.join(temporary, 'home'); await mkdir(home);
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CI'].includes(key)) delete process.env[key];
}
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state') });
const { TerminalService } = await import('../src/service.ts');
const service = new TerminalService(path.join(temporary, 'profile'));
try { await service.start(); console.log('ISOLATED_START_OK'); }
catch (error) {
  // Raw details are confined to this explicit synthetic-profile diagnostic.
  console.error(JSON.stringify({ name: error.name, message: error.message, code: error.code, signal: error.signal, killed: error.killed, syscall: error.syscall, stderr: error.stderr, stack: error.stack }, null, 2));
  process.exitCode = 1;
} finally { await service.close().catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
