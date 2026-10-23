import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { createControlPort } from './controlPort.js';
import { GHOST_NODE_CHILD_MODE_FLAG } from './nodeProtocol.js';
import type { NodeWorkerProcess, NodeWorkerStartupObservation } from './processTypes.js';

export interface NativeNodeWorkerOptions {
  /** The installed host's bundled Node, never an Electron executable. */
  nodePath: string;
  /** Built CJS bootstrap; loading plugins remains in a separate process. */
  workerPath: string;
}

/** Native counterpart of Desktop's utilityProcess adapter. The caller remains
 * responsible for the existing broker's install approval and owner checks. */
export function createNativeNodeWorkerProcess(
  options: NativeNodeWorkerOptions, entryPath: string, _cwd: string,
  ghostId: string, childArgs?: string[],
): NodeWorkerProcess {
  if (![options.nodePath, options.workerPath, entryPath].every(value => path.isAbsolute(value))) throw new Error('PLUGIN_WORKER_PATH_INVALID');
  const env: NodeJS.ProcessEnv = { CINDY_GHOST_ID: ghostId };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const isChild = childArgs !== undefined;
  const child = spawn(options.nodePath, [options.workerPath, entryPath, ...(isChild ? [GHOST_NODE_CHILD_MODE_FLAG, ...childArgs] : [])], {
    cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const controls = new Set<(value: unknown) => void>();
  const observers = new Set<(value: NodeWorkerStartupObservation) => void>();
  let observation: NodeWorkerStartupObservation | undefined;
  let killed = false, destroyed = false, ready = false, messageCount = 0;
  const port = createControlPort(child.stdio[3] as Duplex, () => { child.kill(); });
  port.on('message', ({ data }) => {
    messageCount++;
    if (!ready && data && typeof data === 'object' && (data as { type?: unknown }).type === 'ready') {
      ready = true; events.emit('spawn'); return;
    }
    if (ready && !isChild) for (const listener of controls) listener(data);
  });
  child.on('spawn', () => {
    observation = { stage: 'utility-process-spawned', ...(child.pid ? { pid: child.pid } : {}) };
    for (const listener of observers) { try { listener(observation); } catch { /* diagnostics only */ } }
  });
  child.on('exit', (code, signal) => { destroyed = true; killed = true; events.emit('exit', code, signal); });
  child.on('error', error => { destroyed = true; events.emit('error', error); });
  const adapter: NodeWorkerProcess = {
    stdin: {
      get destroyed() { return destroyed; },
      write(chunk: string) {
        if (destroyed) return false;
        try { port.postMessage({ type: isChild ? 'stdin-b64' : 'stdin', chunk }); return true; } catch { return false; }
      },
    },
    stdout: child.stdout!, stderr: child.stderr!,
    get pid() { return child.pid; },
    get killed() { return killed; },
    readStartupState: () => ({ messageCount, readySeen: ready, adapterReady: ready }),
    onStartupObservation(listener) { if (observation) { try { listener(observation); } catch { /* diagnostics only */ } } observers.add(listener); },
    onControl(listener) { controls.add(listener); },
    sendControl(message) { if (destroyed) return false; try { port.postMessage(message); return true; } catch { return false; } },
    on(event, listener) { events.on(event, listener); return adapter; },
    once(event, listener) { events.once(event, listener); return adapter; },
    kill(signal) { destroyed = true; killed = true; return child.kill(signal); },
  };
  return adapter;
}
