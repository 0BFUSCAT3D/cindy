import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const VERSION = '0.1.0';

/** Git Bash ships a different whoami.exe. OS management must not depend on
 * whichever Unix compatibility utilities appear first in the interactive PATH. */
export function windowsSystemCommand(name:'whoami'|'schtasks'|'powershell',env:NodeJS.ProcessEnv=process.env):string {
  const root=env.SystemRoot||env.SYSTEMROOT||env.WINDIR||'C:\\Windows';
  if(!path.win32.isAbsolute(root)||/[\r\n\0]/.test(root))throw new Error('WINDOWS_SYSTEM_ROOT_INVALID');
  return path.win32.join(root,'System32',name==='powershell'?'WindowsPowerShell\\v1.0\\powershell.exe':`${name}.exe`);
}

/** Windows PowerShell 5 must rebuild its own module search path. Inheriting
 * PowerShell 7's PSModulePath can load incompatible Security module assemblies. */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}

/** Kept outside the profile so a stopped-profile restore can swap directories
 * without dropping the same lock used by daemon startup. */
export function profileLifecycleLockPath(profileDir: string): string {
  const hash = createHash('sha256').update(path.resolve(profileDir)).digest('hex').slice(0, 24);
  return path.join(path.dirname(profileDir), `.cindy-profile-${hash}.lock`);
}

export function profilePath(name = 'default', env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('INVALID_PROFILE');
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  if (!path.isAbsolute(base)) throw new Error('PROFILE_ROOT_MUST_BE_ABSOLUTE');
  return path.join(base, 'CindyTerminal', 'profiles', name);
}

export function socketPath(profileDir: string): string {
  const hash = createHash('sha256').update(profileDir).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cindy-terminal-${hash}`
    : path.join(os.tmpdir(), `cindy-${hash.slice(0, 12)}`, 'rpc.sock');
}

/** Create a private app-owned directory before storing any credential material. */
export async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_PROFILE_DIRECTORY');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('PROFILE_OWNER_MISMATCH');
    await fs.chmod(directory, 0o700);
    return;
  }
  // Construct a new DACL: removing inheritance alone leaves old explicit grants.
  // The path is data, never interpolated into PowerShell source.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = [System.Security.AccessControl.DirectorySecurity]::new()',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$acl.SetOwner($owner)',
    'foreach ($sid in @($owner, [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18"))) { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"); $acl.AddAccessRule($rule) }',
    // Windows PowerShell 5 provides the .NET Framework ACL API directly. Avoid
    // module auto-loading under a fresh service HOME, which can stall Set-Acl.
    '[System.IO.Directory]::SetAccessControl($env:CINDY_PRIVATE_DIRECTORY, $acl)',
  ].join('; ');
  await execFileAsync(windowsSystemCommand('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15_000, env: { ...windowsPowerShellEnv(), CINDY_PRIVATE_DIRECTORY: directory },
  });
}

export async function readPrivateFile(file: string): Promise<Buffer | null> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const link = await fs.lstat(file);
      if (!stat.isFile() || link.isSymbolicLink() || link.ino !== stat.ino) throw new Error('UNSAFE_PRIVATE_FILE');
      if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error('PRIVATE_FILE_PERMISSIONS');
      if (stat.size > 16 * 1024 * 1024) throw new Error('PRIVATE_FILE_TOO_LARGE');
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicPrivateWrite(file: string, data: string | Buffer): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  finally { await fs.rm(temp, { force: true }); }
}

/** Synchronous transaction boundary for the shared plugin credential managers.
 * Same private-file and durable rename contract as atomicPrivateWrite. */
export function atomicPrivateWriteSync(file: string, data: string | Buffer): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(handle, data); fsyncSync(handle); }
    finally { closeSync(handle); }
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const directory = openSync(path.dirname(file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temp, { force: true }); }
}
