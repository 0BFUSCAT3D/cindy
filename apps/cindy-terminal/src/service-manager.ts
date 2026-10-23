import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from './platform.js';

const execute = promisify(execFile);
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[char]!);
const windowsArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const systemdArg = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
type Installation = { version: 1; platform: string; id: string; file: string; starts: 'login' | 'boot'; activeAfter: 'next-login' | 'next-boot'; uninstalling?: boolean };
export interface ServiceRemoval { removed: boolean; requiresLocalCompletion?: boolean }
type ServiceExecutor = (file: string, args: string[], options: { timeout: number; windowsHide?: boolean }) => Promise<{ stdout: string; stderr: string }>;
export interface ServiceEnvironment { platform?: NodeJS.Platform; home?: string; uid?: number; env?: NodeJS.ProcessEnv; execute?: ServiceExecutor }

/** User-scoped registration never captures a token, password or login shell. */
export class TerminalServiceManager {
  readonly id: string;
  private metadata: string;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly uid: number | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execute: ServiceExecutor;
  constructor(readonly profileDir: string, readonly entry: string, readonly node = process.execPath, runtime: ServiceEnvironment = {}) {
    this.platform = runtime.platform ?? process.platform;
    this.home = runtime.home ?? os.homedir();
    this.uid = runtime.uid ?? process.getuid?.();
    this.env = runtime.env ?? process.env;
    this.execute = runtime.execute ?? execute;
    if (![profileDir, entry, node].every(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value))) throw new Error('INVALID_SERVICE_PATH');
    this.id = `app.cindy.terminal.${createHash('sha256').update(profileDir).digest('hex').slice(0, 16)}`;
    this.metadata = path.join(profileDir, 'service-installation.json');
  }
  async status(): Promise<Installation | null> {
    const raw = await readPrivateFile(this.metadata);
    if (!raw) return null;
    const data = JSON.parse(raw.toString()) as Installation;
    if (data.version !== 1 || data.id !== this.id || data.platform !== this.platform) throw new Error('SERVICE_INSTALLATION_INVALID');
    return data;
  }
  async install(): Promise<Installation> {
    await privateDirectory(this.profileDir);
    const args = [this.entry, 'serve', '--state-dir', this.profileDir];
    let file: string;
    let starts: Installation['starts'] = 'login';
    if (this.platform === 'darwin') {
      file = path.join(this.home, 'Library', 'LaunchAgents', `${this.id}.plist`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const log = path.join(this.profileDir, 'service.log');
      await atomicPrivateWrite(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.id}</string><key>ProgramArguments</key><array>${[this.node, ...args].map(value=>`<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>WorkingDirectory</key><string>${xml(this.profileDir)}</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`);
      await this.execute('plutil', ['-lint', file], { timeout: 10_000 });
      await this.execute('launchctl', ['enable', this.launchdTarget()], { timeout: 10_000 });
    } else if (this.platform === 'linux') {
      const config = this.env.XDG_CONFIG_HOME || path.join(this.home, '.config');
      if (!path.isAbsolute(config)) throw new Error('INVALID_CONFIG_HOME');
      file = path.join(config, 'systemd', 'user', `${this.id}.service`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicPrivateWrite(file, `[Unit]\nDescription=Cindy terminal host\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[this.node,...args].map(systemdArg).join(' ')}\nWorkingDirectory=${systemdArg(this.profileDir)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`);
      try {
        await this.execute('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000 });
        await this.execute('systemctl', ['--user', 'enable', `${this.id}.service`], { timeout: 10_000 });
      } catch { throw new Error('USER_SERVICE_MANAGER_UNAVAILABLE'); }
      try {
        const { stdout } = await this.execute('loginctl', ['show-user', String(this.uid), '-p', 'Linger', '--value'], { timeout: 10_000 });
        if (stdout.trim() === 'yes') starts = 'boot';
      } catch { /* The descriptor remains valid for the next user login. */ }
    } else if (this.platform === 'win32') {
      file = path.join(this.profileDir, 'scheduled-service.xml');
      const { stdout } = await this.execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
      const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error('SERVICE_USER_UNAVAILABLE');
      await atomicPrivateWrite(file, `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Cindy terminal host</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="Cindy"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Cindy"><Exec><Command>${xml(this.node)}</Command><Arguments>${xml(args.map(windowsArg).join(' '))}</Arguments><WorkingDirectory>${xml(this.profileDir)}</WorkingDirectory></Exec></Actions></Task>\n`);
      try { await this.execute('schtasks.exe', ['/Create', '/TN', this.id, '/XML', file, '/F'], { windowsHide: true, timeout: 15_000 }); }
      catch { throw new Error('SERVICE_REGISTRATION_FAILED'); }
    } else throw new Error('PLATFORM_NOT_SUPPORTED');
    const installation: Installation = { version: 1, platform: this.platform, id: this.id, file, starts, activeAfter: starts === 'boot' ? 'next-boot' : 'next-login' };
    await atomicPrivateWrite(this.metadata, JSON.stringify(installation));
    return installation;
  }
  async uninstall(): Promise<ServiceRemoval> {
    const current = await this.status();
    if (!current) return { removed: false };
    if (this.platform === 'darwin') {
      // Disable restart before removing the descriptor, but do not kill this
      // process while it is returning an RPC result to the foreground CLI.
      await this.execute('launchctl', ['disable', this.launchdTarget()], { timeout: 10_000 });
    } else if (this.platform === 'linux') {
      try { await this.execute('systemctl', ['--user', 'disable', `${this.id}.service`], { timeout: 10_000 }); }
      catch { throw new Error('SERVICE_UNREGISTRATION_FAILED'); }
    } else if (this.platform === 'win32') {
      try { await this.execute('schtasks.exe', ['/Delete', '/TN', this.id, '/F'], { windowsHide: true, timeout: 15_000 }); }
      catch { throw new Error('SERVICE_UNREGISTRATION_FAILED'); }
    }
    // The installation record is trusted only for its fixed profile-derived path.
    const expected = this.platform === 'darwin'
      ? path.join(this.home, 'Library', 'LaunchAgents', `${this.id}.plist`)
      : this.platform === 'win32' ? path.join(this.profileDir, 'scheduled-service.xml')
      : path.join(this.env.XDG_CONFIG_HOME || path.join(this.home, '.config'), 'systemd', 'user', `${this.id}.service`);
    if (current.file !== expected) throw new Error('SERVICE_INSTALLATION_INVALID');
    await fs.rm(expected, { force: true });
    if (this.platform === 'darwin') {
      await atomicPrivateWrite(this.metadata, JSON.stringify({ ...current, uninstalling: true }));
      return { removed: false, requiresLocalCompletion: true };
    }
    await fs.rm(this.metadata, { force: true });
    if (this.platform === 'linux') await this.execute('systemctl', ['--user', 'daemon-reload'], { timeout: 10_000 });
    return { removed: true };
  }

  private launchdTarget(): string {
    const uid = this.uid;
    if (uid === undefined) throw new Error('SERVICE_USER_UNAVAILABLE');
    return `gui/${uid}/${this.id}`;
  }

  /** Foreground CLI only, after the uninstall RPC has returned and disconnected.
   * bootout terminates the launched service, including its keep-alive job. */
  async completeUninstall(): Promise<ServiceRemoval> {
    if (this.platform !== 'darwin') return this.uninstall();
    const current = await this.status();
    if (!current) return { removed: false };
    if (!current.uninstalling) throw new Error('SERVICE_UNINSTALL_NOT_PREPARED');
    const target = this.launchdTarget();
    try { await this.execute('launchctl', ['bootout', target], { timeout: 15_000 }); }
    catch {
      // An ordinary manually started daemon has no launchd job. Only the
      // command's explicit no-service result can count as already unloaded.
      try {
        await this.execute('launchctl', ['print', target], { timeout: 10_000 });
        throw new Error('SERVICE_UNREGISTRATION_FAILED');
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        if (typeof stderr !== 'string' || !/could not find (?:specified )?service/i.test(stderr)) throw new Error('SERVICE_UNREGISTRATION_FAILED');
      }
    }
    await fs.rm(this.metadata, { force: true });
    return { removed: true };
  }
}
