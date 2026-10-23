import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { EngineError, type EngineKind } from './types.js';

export interface NativeCommand { command: string; args: string[]; env: NodeJS.ProcessEnv }

export function nativeEngineCandidates(kind: EngineKind, env = process.env, platform = process.platform): string[] {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const name = kind === 'claude-code' ? 'claude' : kind;
  const folders = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  folders.push(path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'));
  if (platform === 'win32') folders.push(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(home, 'scoop', 'shims'));
  else folders.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin');
  return [...new Set(folders)].flatMap(folder => (platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']).map(extension => path.join(folder, name + extension)));
}

/** cmd.exe cannot execute a .cmd file through execFile. The executable travels
 * through a single environment expansion, not interpolated shell syntax; args
 * are restricted to the non-secret vendor commands built below. */
export function nativeCommand(binary: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): NativeCommand {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { command: binary, args, env: { ...env } };
  if (/["\r\n\x00]/.test(binary) || args.some(arg => !/^[a-zA-Z0-9_./:@+-]+$/.test(arg))) throw new EngineError('unsupported_native_argument');
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `""%CINDY_NATIVE_EXECUTABLE%" ${args.map(arg => `"${arg}"`).join(' ')}"`],
    env: { ...env, CINDY_NATIVE_EXECUTABLE: binary },
  };
}

export function runNative(binary: string, args: string[], options: { interactive?: boolean; signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = nativeCommand(binary, args, options.env);
  return new Promise((resolve, reject) => {
    const settings: SpawnOptions = { env: command.env, cwd: options.cwd, shell: false, windowsHide: !options.interactive, stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] };
    const child = spawn(command.command, command.args, settings);
    let stdout = '', stderr = '', finished = false;
    const end = (error?: EngineError, code = 1) => {
      if (finished) return;
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve({ code, stdout, stderr });
    };
    const abort = () => { child.kill(); end(new EngineError('native_cancelled')); };
    const timer = setTimeout(() => { child.kill(); end(new EngineError('native_timeout')); }, options.timeout ?? (options.interactive ? 20 * 60_000 : 15_000));
    timer.unref();
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream?.on('data', (chunk: Buffer) => {
      if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 256_000) { child.kill(); end(new EngineError('native_output_too_large')); }
    });
    child.once('error', () => end(new EngineError('native_start_failed')));
    child.once('close', code => end(undefined, code ?? 1));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export type NativeLoginState = 'authenticated' | 'signed-out' | 'non-subscription' | 'unavailable';
export async function nativeLoginStatus(kind: EngineKind, binary: string, provider?: string): Promise<NativeLoginState> {
  try {
    if (kind === 'pi' && (!provider || !/^[a-zA-Z0-9_.-]{1,100}$/.test(provider))) return 'unavailable';
    const args = kind === 'claude-code' ? ['auth', 'status', '--json'] : kind === 'codex' ? ['login', 'status'] : ['auth', 'check', '--provider', provider!, '--json', '--no-refresh'];
    const result = await runNative(binary, args);
    if (kind === 'claude-code') {
      const state = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (!state.loggedIn) return 'signed-out';
      return state.authMethod === 'claude.ai' || state.authMethod === 'oauth' && Boolean(state.subscriptionType) ? 'authenticated' : 'non-subscription';
    }
    if (kind === 'codex') {
      const text = result.stdout + result.stderr;
      return /api key/i.test(text) ? 'non-subscription' : result.code === 0 && /logged in/i.test(text) ? 'authenticated' : 'signed-out';
    }
    // The documented exit contract is enough; never request or expose credentials.
    return result.code === 0 ? 'authenticated' : result.code === 1 ? 'signed-out' : 'unavailable';
  } catch { return 'unavailable'; }
}

export function nativeLoginCommand(kind: EngineKind, operation: 'login' | 'logout'): { args: string[]; instruction?: 'pi-login' | 'pi-logout' } {
  if (kind === 'pi') return { args: ['--no-session'], instruction: operation === 'login' ? 'pi-login' : 'pi-logout' };
  return { args: kind === 'codex' ? operation === 'login' ? ['login', '--device-auth'] : ['logout'] : ['auth', operation, ...(operation === 'login' ? ['--claudeai'] : [])] };
}

/** Invoke from the foreground CLI after Ink unmounts. Never route this through
 * daemon RPC, logs or model tools. Pi requires the user's /login or /logout in
 * its native TUI; a slash command must not be passed as a model prompt. */
export async function runNativeLogin(kind: EngineKind, binary: string, operation: 'login' | 'logout', options: { signal?: AbortSignal; onInstruction?: (instruction: 'pi-login' | 'pi-logout') => void; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new EngineError('native_tty_required');
  const command = nativeLoginCommand(kind, operation);
  if (command.instruction) options.onInstruction?.(command.instruction);
  const env = { ...(options.env ?? process.env) };
  if (kind === 'claude-code') {
    delete env.CLAUDE_CONFIG_DIR;
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL;
  }
  return (await runNative(binary, command.args, { interactive: true, signal: options.signal, env })).code;
}
