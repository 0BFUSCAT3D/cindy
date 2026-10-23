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
