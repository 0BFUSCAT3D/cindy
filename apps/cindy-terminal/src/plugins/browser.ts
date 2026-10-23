import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { privateDirectory } from '../platform.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

/** Browser-backed capabilities are lazy. The host and its model runtimes stay
 * usable on a machine where no browser has been installed yet. A system browser
 * gets an ephemeral sandbox context; its personal profile is never opened. */
export class TerminalBrowserRuntime {
  private flight?: Promise<string>;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private options: {root:string;changed?(status:'installing'|'ready'|'failed'):void}) {}

  resolve(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('BROWSER_RUNTIME_CLOSED'));
    if (!this.flight) {
      const flight = this.prepare();
      this.flight = flight;
      void flight.catch(() => { if (this.flight === flight) this.flight = undefined; });
    }
    return this.flight;
  }

  private async prepare(): Promise<string> {
    const candidates = process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((value):value is string => !!value).flatMap(root => [path.join(root,'Google/Chrome/Application/chrome.exe'),path.join(root,'Microsoft/Edge/Application/msedge.exe')])
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    for (const candidate of candidates) {
      try { await access(candidate,constants.X_OK); this.abort.signal.throwIfAborted(); return candidate; } catch (error) { if (this.closed) throw error; }
    }
    const directory = path.join(this.options.root,'chromium');
    await privateDirectory(directory);
    const env = {...process.env,PLAYWRIGHT_BROWSERS_PATH:directory};
    // Ask the pinned runtime for its platform-specific path instead of copying
    // its private revision/directory naming rules into Cindy.
    const probe = `process.stdout.write(require(${JSON.stringify(require.resolve('playwright-core'))}).chromium.executablePath())`;
    const {stdout} = await execute(process.execPath,['-e',probe],{env,timeout:15_000,windowsHide:true,signal:this.abort.signal});
    const executable = stdout.trim();
    if (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) throw new Error('BROWSER_RUNTIME_PATH_INVALID');
    try { await access(executable,constants.X_OK); return executable; } catch { this.abort.signal.throwIfAborted(); }
    this.options.changed?.('installing');
    try {
      await new Promise<void>((resolve,reject) => {
        const child=spawn(process.execPath,[path.join(path.dirname(require.resolve('playwright-core/package.json')),'cli.js'),'install','chromium'],{env,stdio:'ignore',windowsHide:true,signal:this.abort.signal});
        child.once('error',reject);
        child.once('exit',code => code===0?resolve():reject(new Error('BROWSER_RUNTIME_INSTALL_FAILED')));
      });
      this.abort.signal.throwIfAborted();
      await access(executable,constants.X_OK);
      this.options.changed?.('ready');
      return executable;
    } catch (cause) { this.options.changed?.('failed'); throw new Error('BROWSER_RUNTIME_INSTALL_FAILED',{cause}); }
  }
  async close():Promise<void> { this.closed=true;this.abort.abort();await this.flight?.catch(()=>{}); }
}
