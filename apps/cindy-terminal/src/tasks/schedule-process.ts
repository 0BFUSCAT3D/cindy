import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { FireContext, Schedule, PreRunHookRunResult } from '@cindy/maker-scheduler';

/** Deliberately excludes credentials inherited by the daemon. */
function processEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key,value]) => value !== undefined && /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|LC_CTYPE|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|SHELL|USER|USERNAME|LOGNAME)$/i.test(key)));
}
type Outcome = { code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number };
/** Process-group cancellation and UTF-8 decoding stay independent of the Agent loop. */
function execute(command: string, cwd: string, ctx: FireContext, timeoutMs: number | undefined, start: unknown, onFrame?: (frame: Record<string, unknown>) => Promise<unknown>): Promise<Outcome> {
  ctx.signal.throwIfAborted();
  if (ctx.canDispatch && !ctx.canDispatch()) throw new Error('SCHEDULE_OWNER_CHANGED');
  return new Promise((resolve,reject) => {
    const at = Date.now();
    const child = spawn(command.replace(/^xdt-node\s+/, `"${process.execPath}" `), { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: { ...processEnv(), ...(onFrame ? { CINDY_SCRIPT_PROTOCOL: '1', XDT_MAKER_SCRIPT_PROTOCOL: '1', PYTHONUTF8: '1' } : {}) } });
    let stdout = '', stderr = '', buffer = '', timedOut = false, finished = false, failure: Error | null = null;
    const decoder = new StringDecoder('utf8'); const errors = new StringDecoder('utf8');
    let protocol: string | undefined; let completed = false; const seen = new Set<string>(); const calls = new Set<Promise<void>>();
    const write = (frame: unknown) => child.stdin?.write(JSON.stringify(frame) + '\n');
    const kill = () => { if (child.exitCode !== null || child.signalCode !== null) return; if (process.platform === 'win32') { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.on('error', () => child.kill()); } else try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const abort = () => { failure = new Error('SCHEDULE_ABORTED'); kill(); };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; failure = new Error('SCRIPT_TIMEOUT'); kill(); }, timeoutMs) : undefined;
    ctx.signal.addEventListener('abort', abort, { once: true }); child.stdin?.on('error', () => {});
    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (!frame || typeof frame !== 'object' || !['cindy-script/1', 'xdt-maker-script/1'].includes(String(frame.protocol)) || protocol && protocol !== frame.protocol || completed) throw new Error('INVALID_SCRIPT_FRAME');
        protocol = String(frame.protocol);
        if (frame.type === 'complete') { completed = true; stdout = JSON.stringify(frame); if(!calls.size)child.stdin?.end(); return; }
        if (frame.type !== 'call' || typeof frame.id !== 'string' || !frame.id || seen.has(frame.id) || calls.size >= 16 || text.length > 262144) throw new Error('INVALID_SCRIPT_FRAME');
        seen.add(frame.id);
        const call = (async () => { try { const result = await onFrame!(frame); if (ctx.signal.aborted) throw new Error('SCHEDULE_ABORTED'); write({ protocol, type: 'call_result', id: frame.id, ok: true, result }); } catch (error) { if (completed) failure = new Error('SCRIPT_CALL_FAILED_AFTER_COMPLETE'); write({ protocol, type: 'call_result', id: frame.id, ok: false, error: { code: 'CALL_FAILED', message: error instanceof Error ? error.message : 'CALL_FAILED' } }); } })();
        calls.add(call); void call.finally(() => { calls.delete(call); if (completed && !calls.size) child.stdin?.end(); });
      } catch (error) { failure = error instanceof Error ? error : new Error('INVALID_SCRIPT_FRAME'); kill(); }
      if (completed && !calls.size) child.stdin?.end();
    };
    child.stdout?.on('data', chunk => { ctx.onProgress?.(); const text = decoder.write(chunk); if (!onFrame) { stdout = (stdout + text).slice(0,8192); return; } buffer += text; let index; while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0,index)); buffer = buffer.slice(index+1); } if (buffer.length > 262144) { failure = new Error('SCRIPT_FRAME_TOO_LARGE'); kill(); } });
    child.stderr?.on('data', chunk => { stderr = (stderr + errors.write(chunk)).slice(0,8192); ctx.onProgress?.(); });
    child.once('error', error => finish(null,error));
    child.once('close', code => { if (onFrame) { buffer += decoder.end(); if (buffer.trim()) line(buffer); } else stdout = (stdout + decoder.end()).slice(0,8192); void Promise.allSettled(calls).then(() => finish(code)); });
    function finish(code: number | null, error?: Error) { if (finished) return; finished=true; if(timer)clearTimeout(timer);ctx.signal.removeEventListener('abort',abort); if (error || failure) reject(error ?? failure); else if(onFrame && !completed)reject(new Error('SCRIPT_COMPLETE_REQUIRED')); else resolve({code,stdout,stderr,timedOut,durationMs:Date.now()-at}); }
    write(onFrame ? { protocol:'xdt-maker-script/1',type:'start',...start as object } : start);
    if (!onFrame) child.stdin?.end();
  });
}
export async function preRun(schedule: Schedule, ctx: FireContext, cwd: string): Promise<PreRunHookRunResult | null> {
  if (!schedule.preRunHook?.command) return null;
  // sh syntax errors use exit 2 too; distinguish them from an intentional skip.
  if (process.platform !== 'win32') { const syntax = await execute(`/bin/sh -n <<'CINDY_HOOK_SYNTAX'\n${schedule.preRunHook.command}\nCINDY_HOOK_SYNTAX`, cwd, ctx, schedule.preRunHook.timeoutMs, {}); if(syntax.code !== 0)throw new Error('INVALID_PRE_RUN_HOOK_SYNTAX'); }
  const result = await execute(schedule.preRunHook.command,cwd,ctx,schedule.preRunHook.timeoutMs,{event:'schedule-pre-run',scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,firedAt:ctx.firedAt,workingDir:cwd,lastFinishedAt:schedule.lastFinishedAt});
  return { status: result.code === 0 ? 'passed' : result.code === 2 ? 'skipped' : 'failed', decision: result.code === 0 ? 'run' : result.code === 2 ? 'skip' : 'block',exitCode:result.code,durationMs:result.durationMs,stdout:result.stdout,stderr:result.stderr,stdoutTruncated:result.stdout.length>=8192,stderrTruncated:result.stderr.length>=8192,timedOut:result.timedOut,aborted:false };
}
export async function runScript(schedule: Schedule,ctx:FireContext,cwd:string,broker:(method:string,params:Record<string,unknown>)=>Promise<unknown>) {
  const config=schedule.scriptConfig!;
  const result=await execute(config.command,cwd,ctx,config.timeoutMs,{context:{scheduleId:schedule.id,scheduleName:schedule.name,runId:ctx.runId,firedAt:ctx.firedAt,workingDir:cwd,...(schedule.targetSessionId?{targetSessionId:schedule.targetSessionId}:{})}},async frame=>{if(typeof frame.method!=='string')throw new Error('INVALID_SCRIPT_METHOD');return broker(frame.method,frame.params && typeof frame.params==='object' && !Array.isArray(frame.params)?frame.params as Record<string,unknown>:{});});
  if(result.code!==0)throw new Error('SCRIPT_NONZERO_EXIT');
  const frame=JSON.parse(result.stdout) as {resultText?:string;primarySessionId?:string;status?:string};
  if(frame.status==='failed'||frame.status==='error')throw new Error('SCRIPT_REPORTED_FAILURE');
  return {sessionId:typeof frame.primarySessionId==='string'?frame.primarySessionId:'',resultText:typeof frame.resultText==='string'?frame.resultText.slice(0,8192):''};
}
