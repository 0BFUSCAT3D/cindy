// Behavior tier: uninstalling from a daemon RPC must preserve its response,
// then the foreground caller must unload the actual launchd job. No real
// system registration is performed by these command-contract tests.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalServiceManager } from './service-manager.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  const execute = vi.fn(async (_file: string, _args: string[]) => ({ stdout: '', stderr: '' }));
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'darwin', home: directory, uid: 12345, execute });
  return { directory, execute, manager };
}

it('disables restart in the RPC phase and bootouts only after foreground completion', async () => {
  const { execute, manager } = await fixture();
  const installed = await manager.install();
  execute.mockClear();
  expect(await manager.uninstall()).toEqual({ removed: false, requiresLocalCompletion: true });
  expect(execute.mock.calls.map(call => call[1][0])).toEqual(['disable']);
  expect(await stat(installed.file).catch(() => null)).toBeNull();
  expect((await manager.status())?.uninstalling).toBe(true);
  expect(await manager.completeUninstall()).toEqual({ removed: true });
  expect(execute.mock.calls.map(call => call[1][0])).toEqual(['disable', 'bootout']);
  expect(await manager.status()).toBeNull();
});

it('retains retry information if the launchd job is still present', async () => {
  const { execute, manager } = await fixture();
  await manager.install(); await manager.uninstall();
  execute.mockImplementation(async (_file, args) => { if (args[0] === 'bootout') throw new Error('test failure'); return { stdout: 'job exists', stderr: '' }; });
  await expect(manager.completeUninstall()).rejects.toThrow('SERVICE_UNREGISTRATION_FAILED');
  expect((await manager.status())?.uninstalling).toBe(true);
});

it('clears the pending registration when launchctl explicitly reports no loaded job', async () => {
  const { execute, manager } = await fixture();
  await manager.install(); await manager.uninstall();
  execute.mockImplementation(async (_file, args) => {
    if (args[0] === 'bootout') throw new Error('test failure');
    throw Object.assign(new Error('no job'), { stderr: 'Could not find service in domain for user' });
  });
  expect(await manager.completeUninstall()).toEqual({ removed: true });
});

it('keeps Linux registration distinct from running and verifies the explicit boot opt-in', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  let linger = false;
  let running = false;
  const execute = vi.fn(async (file: string, args: string[]) => {
    if (file === 'loginctl') {
      if (args[0] === 'enable-linger') linger = true;
      return { stdout: linger ? 'yes\n' : 'no\n', stderr: '' };
    }
    if (args[1] === 'start') running = true;
    return { stdout: `LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${running ? 2345 : 0}\n`, stderr: '' };
  });
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'linux', home: directory, uid: 12345, env: {}, execute });
  expect(await manager.install()).toMatchObject({ starts: 'login', registrationOnly: true });
  expect(await manager.inspect()).toMatchObject({ registered: true, running: false, starts: 'login', bootEnableCommand: ['loginctl', 'enable-linger', '12345'] });
  expect(await manager.enableBoot()).toMatchObject({ running: false, starts: 'boot' });
  expect(await manager.activate()).toMatchObject({ running: true, starts: 'boot', pid: 2345 });
  expect((await manager.inspect()).bootEnableCommand).toBeUndefined();
});

it('does not call a receipt an active service when the user manager is unavailable', async () => {
  const { manager, execute } = await fixture();
  await manager.install();
  execute.mockRejectedValue(new Error('no GUI login session'));
  expect(await manager.inspect()).toMatchObject({ installation: { registrationOnly: true }, managerAvailable: false, registered: false, running: false });
  await expect(manager.enableBoot()).rejects.toThrow();
});

it.each(['darwin', 'win32'] as const)('registers explicit %s boot operation through the native foreground prompt', async platform => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  const execute = vi.fn(async (file: string, args: string[]) => ({ stdout: file === 'whoami.exe' ? args.length ? '"test-user","S-1-5-21-1234"' : 'machine\\test-user' : file === 'launchctl' && args[0] === 'print' ? 'state = running\npid = 3456\n' : '', stderr: '' }));
  const interactive = vi.fn(async (_file: string, _args: string[], _env?: NodeJS.ProcessEnv) => {});
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform, home: directory, uid: 12345, userName: 'test-user', env: {}, execute, interactive });
  await manager.install();
  await manager.enableBoot();
  expect(await manager.status()).toMatchObject({ scope: 'system', starts: 'boot' });
  if (platform === 'darwin') expect(interactive.mock.calls.length).toBe(3);
  else expect(interactive.mock.calls.length).toBe(1);
  if (platform === 'win32') {
    const [, args, env] = interactive.mock.calls[0];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("Read-Host 'Windows account password' -AsSecureString");
    expect(script).toContain('ZeroFreeBSTR');
    expect(Object.keys(env ?? {})).not.toContain('PASSWORD');
  }
});
