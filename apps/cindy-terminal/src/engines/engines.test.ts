import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { EngineManager } from './manager.js';
import { nativeCommand, nativeLoginCommand, nativeLoginStatus } from './native.js';
import { enginePlatform } from './releases.js';
import { extractEngineArchive } from './archive.js';
import type { EngineRelease } from './types.js';

// Behavior tier: installer publication/rollback and hostile archive boundary;
// native auth must select vendor flows without exposing credential output.
const folders: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function temporary() { const folder = await mkdtemp(path.join(os.tmpdir(), 'cindy-engines-test-')); folders.push(folder); return folder; }
function release(data: Buffer, version = '1.2.3'): EngineRelease {
  return { version, assets: { [enginePlatform()]: { url: 'https://engine.invalid/fake', sha256: createHash('sha256').update(data).digest('hex'), size: data.length, format: 'raw', entrypoint: 'claude' } } };
}
const posix = process.platform !== 'win32';

describe('engine installation', () => {
  it.runIf(posix)('publishes a verified binary atomically and resolves it without PATH changes', async () => {
    const root = await temporary();
    const data = Buffer.from('#!/bin/sh\nprintf "1.2.3\\n"\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data)));
    const manager = new EngineManager({ profileDir: root });
    const result = await manager.installRelease('claude-code', release(data));
    expect(result.source).toBe('managed');
    expect(result.version).toBe('1.2.3');
    expect(await readFile(result.binary!, 'utf8')).toBe(data.toString());
  });

  it.runIf(posix)('a checksum mismatch preserves the last active engine', async () => {
    const root = await temporary();
    const good = Buffer.from('#!/bin/sh\nprintf "1.2.3\\n"\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(good)));
    const manager = new EngineManager({ profileDir: root });
    const first = await manager.installRelease('claude-code', release(good));
    const wrong = release(good, '2.0.0');
    wrong.assets[enginePlatform()]!.sha256 = '0'.repeat(64);
    await expect(manager.installRelease('claude-code', wrong)).rejects.toThrow('engine_checksum_mismatch');
    expect((await manager.resolve('claude-code'))?.binary).toBe(first.binary);
  });

  it.runIf(posix)('repair reuses the active version and digest instead of downgrading to the bundled pin', async () => {
    const root = await temporary();
    const data = Buffer.from('#!/bin/sh\nprintf "99.2.3\\n"\n');
    const fetch = vi.fn(async (_url: unknown) => new Response(data)); vi.stubGlobal('fetch', fetch);
    const manager = new EngineManager({ profileDir: root });
    await manager.installRelease('claude-code', release(data, '99.2.3'));
    const result = await manager.repair('claude-code');
    expect(result.version).toBe('99.2.3');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(call => String(call[0]) === 'https://engine.invalid/fake')).toBe(true);
  });

  it.runIf(posix)('does not activate an executable reporting a different version', async () => {
    const manager = new EngineManager({ profileDir: await temporary() });
    const data = Buffer.from('#!/bin/sh\nprintf "9.9.9\\n"\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data)));
    await expect(manager.installRelease('claude-code', release(data))).rejects.toThrow('engine_version_mismatch');
    expect((await manager.resolve('claude-code'))?.source).not.toBe('managed');
  });

  it('rejects unavailable platform assets before downloading', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(new EngineManager({ profileDir: await temporary() }).installRelease('pi', { version: '1.0.0', assets: {} })).rejects.toThrow('engine_platform_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.runIf(posix)('unpacks Pi when its enclosing directory has the same name as the binary', async () => {
    const root = await temporary();
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'pi/theme'), { recursive: true });
    await writeFile(path.join(source, 'pi/pi'), '#!/bin/sh\nprintf "1.2.3\\n"\n');
    for (const name of ['dark', 'light', 'theme-schema']) await writeFile(path.join(source, 'pi/theme', `${name}.json`), '{}');
    const archive = path.join(root, 'pi.tar.gz');
    await tar.c({ cwd: source, file: archive, gzip: true }, ['pi']);
    const data = await readFile(archive);
    const manifest = release(data);
    manifest.assets[enginePlatform()]!.format = 'tar.gz';
    manifest.assets[enginePlatform()]!.entrypoint = 'pi';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data)));
    const result = await new EngineManager({ profileDir: path.join(root, 'profile') }).installRelease('pi', manifest);
    expect(result.source).toBe('managed');
    expect(await readFile(path.join(path.dirname(result.binary!), 'theme/dark.json'), 'utf8')).toBe('{}');
  });

  it('rejects links inside the real tar extractor', async () => {
    const root = await temporary();
    const source = path.join(root, 'source'); const destination = path.join(root, 'dest');
    await mkdir(source); await mkdir(destination);
    await writeFile(path.join(source, 'entry'), 'content');
    const { symlink } = await import('node:fs/promises');
    await symlink('entry', path.join(source, 'link'));
    const archive = path.join(root, 'bad.tar.gz');
    await tar.c({ cwd: source, file: archive, gzip: true }, ['link']);
    await expect(extractEngineArchive(archive, destination, 'tar.gz')).rejects.toThrow('unsafe_archive_entry');
  });

  it('waits for the real ZIP reader to close before allowing staging cleanup', async () => {
    // Behavior: the prior extractor resolved at `end`, before fd close, which
    // permits Windows staging cleanup to race a still-open archive.
    const root = await temporary();
    const archive = path.join(root, 'empty.zip');
    const zip = Buffer.alloc(22); zip.writeUInt32LE(0x06054b50);
    await writeFile(archive, zip);
    const close = fs.close;
    let releaseClose!: () => void;
    let reportClose!: () => void;
    const closing = new Promise<void>(resolve => { reportClose = resolve; });
    vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
      close(fd, error => { releaseClose = () => callback?.(error); reportClose(); });
    });
    let settled = false;
    const extraction = extractEngineArchive(archive, root, 'zip').then(() => { settled = true; });
    await closing;
    await Promise.resolve();
    const settledBeforeClose = settled;
    releaseClose();
    await extraction;
    expect(settledBeforeClose).toBe(false);
    expect(settled).toBe(true);
  });
});

describe('native authentication', () => {
  it('selects subscription/device auth and leaves Pi commands in its native TUI', () => {
    expect(nativeLoginCommand('claude-code', 'login').args).toEqual(['auth', 'login', '--claudeai']);
    expect(nativeLoginCommand('codex', 'login').args).toEqual(['login', '--device-auth']);
    expect(nativeLoginCommand('pi', 'logout')).toEqual({ args: ['--no-session'], instruction: 'pi-logout' });
  });

  it('quotes Windows cmd launch without interpolating a hostile path', () => {
    const binary = 'C:\\Users\\A&B%CD%\\native.cmd';
    const command = nativeCommand(binary, ['login', '--device-auth'], { ComSpec: 'C:\\Windows\\cmd.exe' }, 'win32');
    expect(command.command).toBe('C:\\Windows\\cmd.exe');
    expect(command.args.join(' ')).not.toContain(binary);
    expect(command.env.CINDY_NATIVE_EXECUTABLE).toBe(binary);
    expect(() => nativeCommand(binary, ['evil&command'], {}, 'win32')).toThrow('unsupported_native_argument');
  });

  it.runIf(posix)('does not treat Console or API-key login as subscription authentication', async () => {
    const root = await temporary(); const executable = path.join(root, 'fake');
    await writeFile(executable, '#!/bin/sh\nprintf \'{"loggedIn":true,"authMethod":"console"}\\n\'\n'); await chmod(executable, 0o700);
    expect(await nativeLoginStatus('claude-code', executable)).toBe('non-subscription');
    await writeFile(executable, '#!/bin/sh\nprintf "Logged in using an API key\\n"\n');
    expect(await nativeLoginStatus('codex', executable)).toBe('non-subscription');
  });
});
