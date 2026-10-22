import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import type {
  AgentAdapter,
  AgentAdapterEvent,
  AgentAdapterMetadata,
  AgentSession,
} from '@cindy/maker-core/agent-adapters';

export class NativeAgentError extends Error {
  readonly name = 'NativeAgentError';
  constructor(
    readonly code:
      | 'instance-not-discovered'
      | 'workspace-required'
      | 'startup-failed'
      | 'needs-auth'
      | 'auth-unavailable'
      | 'timeout'
      | 'protocol-error'
      | 'closed'
      | 'busy'
      | 'invalid-permission'
      | 'unexpected-cancellation',
    message: string = code,
  ) {
    super(message);
  }
}
export interface NativeSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
  shell: false;
  windowsHide: boolean;
  detached: boolean;
}
export type NativeSpawn = (
  command: string,
  args: readonly string[],
  options: NativeSpawnOptions,
) => ChildProcessWithoutNullStreams;
export interface NativeAdapterOptions {
  accessFile?: (path: string, mode?: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: NativeSpawn;
  closeGraceMs?: number;
  requestTimeoutMs?: number;
}
export interface NativeAgentDefinition {
  id: string;
  name: string;
  executables: readonly string[];
  args: readonly string[];
  protocol?: 'step-rpc' | 'msp' | 'crush-http';
  /** Avoid a different product with the same executable name (Step / Smallstep). */
  homeOnly?: boolean;
  /** Documented native launch differences; never supplied by a controller. */
  argsByPlatform?: Partial<Record<NodeJS.Platform, readonly string[]>>;
  /** Only documented installation locations; never inspect application internals/login stores. */
  homeBin?: string;
  /** Official npm Node entry, relative to the Windows npm prefix (no .cmd shell). */
  windowsNpmEntry?: string;
  authenticateMethod?: string;
  /** Bounded time for the native browser flow; other RPC deadlines stay unchanged. */
  authenticateTimeoutMs?: number;
  /** Opt-in for native versions that incorrectly acknowledge failed prompts with no output. */
  rejectEmptyTurn?: boolean;
  /** Some native ACP servers have no client-mediated permission requests. */
  supportsPermissions?: boolean;
  /** Let an owned daemon session drain on stdin EOF before terminating its CLI. */
  inputCloseGraceMs?: number;
  /** Exact public vendor diagnostics that use a nonstandard auth error code. */
  authenticationErrors?: readonly { code: number; message: string }[];
}
export function nativeMetadata(definition: NativeAgentDefinition): AgentAdapterMetadata {
  return {
    id: definition.id,
    kind: 'agent-native',
    displayName: definition.name,
    credentialBoundary: 'agent-owned',
    capabilities: [
      definition.protocol ?? 'acp',
      'workspace',
      'streaming',
      'cancellation',
      ...(definition.supportsPermissions === false ? [] : ['permissions']),
    ],
  };
}
export async function findNativeExecutable(
  definition: NativeAgentDefinition,
  options: NativeAdapterOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env,
    platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const directories = (definition.homeOnly ? '' : (env.PATH ?? env.Path ?? ''))
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p));
  const home = env.HOME ?? env.USERPROFILE;
  if (definition.homeBin && home && path.isAbsolute(home))
    directories.push(path.join(home, definition.homeBin));
  // .cmd/.bat need shell evaluation. Only native executables are supported on Windows for now.
  const suffixes = platform === 'win32' ? ['.exe'] : [''];
  for (const directory of new Set(directories))
    for (const name of definition.executables)
      for (const suffix of suffixes) {
        const candidate = path.join(directory, name + suffix);
        try {
          await (options.accessFile ?? access)(
            candidate,
            platform === 'win32' ? constants.F_OK : constants.X_OK,
          );
          return candidate;
        } catch {
          /* another documented executable location */
        }
      }
  return null;
}

async function findNativeLaunch(
  definition: NativeAgentDefinition,
  options: NativeAdapterOptions,
): Promise<{ command: string; prefixArgs: string[] } | null> {
  const executable = await findNativeExecutable(definition, options);
  if (executable) return { command: executable, prefixArgs: [] };
  if ((options.platform ?? process.platform) !== 'win32' || !definition.windowsNpmEntry)
    return null;
  // npm installs .cmd shims on Windows. Invoke the vendor's Node entry with an
  // independently discovered node.exe; never evaluate a shim or use Electron as Node.
  const node = await findNativeExecutable(
    { id: 'node', name: 'Node.js', executables: ['node'], args: [] },
    options,
  );
  if (!node) return null;
  const env = options.env ?? process.env;
  const prefixes = (env.PATH ?? env.Path ?? '').split(win32.delimiter);
  if (env.APPDATA && win32.isAbsolute(env.APPDATA)) prefixes.push(win32.join(env.APPDATA, 'npm'));
  for (const prefix of new Set(prefixes.filter((p) => win32.isAbsolute(p)))) {
    const entry = win32.join(prefix, definition.windowsNpmEntry);
    try {
      await (options.accessFile ?? access)(entry, constants.F_OK);
      return { command: node, prefixArgs: [entry] };
    } catch {
      /* another npm prefix; no user configuration or credential files are read */
    }
  }
  return null;
}
/** Agent-owned login only. Never inherit Cindy keys, config-home overrides or Node injection. */
export function nativeAgentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'USERPROFILE',
    'PATH',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'CODEBUDDY_INTERNET_ENVIRONMENT',
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())));
}
type RpcObject = Record<string, unknown>;
function object(value: unknown): RpcObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcObject)
    : null;
}
function text(value: unknown, max = 16_384): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
function permissionKind(value: unknown) {
  return value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always'
    ? value
    : undefined;
}
const MAX_FRAME = 1024 * 1024;

/** ACP v1 JSON-RPC: bounded NDJSON, requests in both directions, cancel is a notification. */
export class NativeRpcConnection {
  private nextId = 0;
  private buffer = '';
  private ended = false;
  private exited = false;
  private closing: Promise<void> | null = null;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  onMessage: (message: RpcObject) => void = () => {};
  onClose: () => void = () => {};
  onDispose: () => void = () => {};
  /** Owned launch resources are removed only after process teardown, never on receipt of EOF. */
  onReap: () => Promise<void> = async () => {};
  get closed(): boolean {
    return this.ended;
  }
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private options: NativeAdapterOptions,
    private definition: NativeAgentDefinition,
  ) {
    child.stdout.setEncoding('utf8');
    if (definition.protocol === 'crush-http') child.stdout.resume();
    else
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) {
            void this.close();
            return;
          }
          let message: RpcObject | null;
          try {
            message = object(JSON.parse(line));
          } catch {
            void this.close();
            return;
          }
          if (
            message &&
            this.definition.protocol === 'step-rpc' &&
            typeof message.type === 'string'
          ) {
            message =
              message.type === 'response'
                ? {
                    jsonrpc: '2.0',
                    id:
                      typeof message.id === 'string' && /^\d+$/.test(message.id)
                        ? Number(message.id)
                        : null,
                    ...(message.success === true
                      ? { result: message.data }
                      : { error: { code: -32603 } }),
                  }
                : { jsonrpc: '2.0', method: message.type, params: message };
          }
          if (!message || message.jsonrpc !== '2.0') {
            void this.close();
            return;
          }
          // Agent requests may reuse client numeric ids. Method takes precedence.
          if (typeof message.method === 'string') {
            try {
              this.onMessage(message);
            } catch {
              void this.close();
              return;
            }
          } else if (typeof message.id === 'number') {
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            const error = object(message.error);
            if (error)
              pending.reject(
                new NativeAgentError(
                  (this.definition.protocol !== 'msp' && error.code === -32000) ||
                    this.definition.authenticationErrors?.some(
                      (known) => known.code === error.code && known.message === error.message,
                    )
                    ? 'needs-auth'
                    : 'protocol-error',
                ),
              );
            else pending.resolve(message.result);
          }
        }
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME) void this.close();
      });
    child.stderr.resume(); // Never relay CLI diagnostics/auth payloads to UI or logs.
    child.stdin.on('error', () => {
      void this.close();
    });
    child.on('error', () => {
      void this.close();
    });
    child.on('close', () => {
      this.exited = true;
      this.finish();
      void this.close();
    });
  }
  write(message: RpcObject): void {
    if (this.ended) throw new NativeAgentError('closed');
    this.child.stdin.write(
      JSON.stringify(
        this.definition.protocol === 'step-rpc' ? message : { jsonrpc: '2.0', ...message },
      ) + '\n',
    );
  }
  request(
    method: string,
    params: unknown,
    timeout = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(new NativeAgentError('closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new NativeAgentError('timeout'));
              void this.close();
            }, timeout)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(
          this.definition.protocol === 'step-rpc'
            ? { ...object(params), id: String(id), type: method }
            : { id, method, params },
        );
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new NativeAgentError('closed'));
      }
    });
  }
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.buffer = '';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NativeAgentError('closed'));
    }
    this.pending.clear();
    this.onDispose();
    this.onClose();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const inputCloseGraceMs = this.definition.inputCloseGraceMs ?? 0;
    const hasProcessGroup = () => {
      if ((this.options.platform ?? process.platform) === 'win32' || !this.child.pid) return false;
      try {
        return process.kill(-this.child.pid, 0);
      } catch {
        return false;
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if ((this.options.platform ?? process.platform) !== 'win32' && this.child.pid)
          process.kill(-this.child.pid, signal);
        else if ((this.options.platform ?? process.platform) === 'win32' && this.child.pid) {
          // No shell: taskkill also closes native tools descended from the Agent.
          const killer = spawn('taskkill.exe', ['/pid', String(this.child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            try {
              this.child.kill(signal);
            } catch {
              /* already exited */
            }
          });
        } else this.child.kill(signal);
      } catch {
        /* already reaped */
      }
    };
    this.closing = Promise.resolve()
      .then(async () => {
        try {
          this.child.stdin.end();
        } catch {
          /* already closed */
        }
        if (inputCloseGraceMs > 0 && !this.exited)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.child.off('close', done);
              resolve();
            };
            const timer = setTimeout(done, inputCloseGraceMs);
            this.child.once('close', done);
          });
        if (inputCloseGraceMs === 0 || !this.exited || hasProcessGroup()) kill('SIGTERM');
        // A native tool can outlive the Agent and close its inherited pipes. The
        // parent's close event alone must not cancel process-group cleanup.
        if (!this.exited || hasProcessGroup())
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.child.off('close', onClose);
              resolve();
            };
            const onClose = () => {
              if (!hasProcessGroup()) done();
            };
            const timer = setTimeout(() => {
              kill('SIGKILL');
              done();
            }, this.options.closeGraceMs ?? 750);
            this.child.once('close', onClose);
          });
      })
      .finally(() => this.onReap());
    this.finish();
    return this.closing;
  }
}

export interface NativePreparedSession {
  args: readonly string[];
  connect(
    rpc: NativeRpcConnection,
    request: Parameters<AgentAdapter['start']>[0],
    root: string,
  ): Promise<AgentSession>;
  dispose(): Promise<void>;
}

export function createNativeProcessAdapter(
  definition: NativeAgentDefinition,
  options: NativeAdapterOptions = {},
  connect?: (
    rpc: NativeRpcConnection,
    request: Parameters<AgentAdapter['start']>[0],
    root: string,
  ) => Promise<AgentSession>,
  prepare?: () => Promise<NativePreparedSession>,
): AgentAdapter {
  const discovered = new Map<string, { command: string; prefixArgs: string[] }>();
  const metadata = nativeMetadata(definition);
  return {
    id: definition.id,
    kind: 'agent-native',
    metadata,
    async discover(node) {
      if (node.kind !== 'local' || node.status !== 'online') return [];
      const id = definition.id + ':' + node.id;
      discovered.delete(id);
      const launch = await findNativeLaunch(definition, options);
      if (!launch) return [];
      discovered.set(id, launch);
      return [
        {
          id,
          adapterId: definition.id,
          displayName: definition.name,
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: metadata.capabilities,
        },
      ];
    },
    async start(request) {
      const launch = discovered.get(request.instanceId);
      if (!launch || request.instanceId !== definition.id + ':' + request.runtimeNodeId)
        throw new NativeAgentError('instance-not-discovered');
      const root = request.workspace?.root;
      const platform = options.platform ?? process.platform;
      const path = platform === 'win32' ? win32 : posix;
      if (
        !root ||
        !path.isAbsolute(root) ||
        root.includes('\0') ||
        request.workspace?.runtimeNodeId !== request.runtimeNodeId
      )
        throw new NativeAgentError('workspace-required');
      if (request.signal?.aborted) throw new NativeAgentError('closed');
      const prepared = prepare ? await prepare() : undefined;
      if (request.signal?.aborted) {
        await prepared?.dispose();
        throw new NativeAgentError('closed');
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (
          options.spawnProcess ?? ((command, args, opts) => spawn(command, [...args], opts))
        )(
          launch.command,
          [
            ...launch.prefixArgs,
            ...(prepared?.args ?? definition.argsByPlatform?.[platform] ?? definition.args),
          ],
          {
            cwd: root,
            env: nativeAgentEnvironment(options.env ?? process.env),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            detached: platform !== 'win32',
          },
        );
      } catch {
        await prepared?.dispose();
        throw new NativeAgentError('startup-failed');
      }
      const rpc = new NativeRpcConnection(child, options, definition);
      if (prepared) rpc.onReap = prepared.dispose;
      const abort = () => {
        void rpc.close();
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      rpc.onDispose = () => request.signal?.removeEventListener('abort', abort);
      const connector = prepared?.connect ?? connect;
      if (connector) {
        try {
          return await connector(rpc, request, root);
        } catch (error) {
          await rpc.close();
          throw error instanceof NativeAgentError ? error : new NativeAgentError('startup-failed');
        }
      }
      const listeners = new Set<(event: AgentAdapterEvent) => void>();
      const emit = (event: AgentAdapterEvent) => {
        if (
          busy &&
          (event.type === 'tool' ||
            (event.type === 'text' && text(object(event.data)?.text).trim()))
        )
          turnHasOutput = true;
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            /* isolate observer */
          }
        }
      };
      const permissions = new Map<
        string,
        { id: unknown; options: string[]; rejectOptions: string[] }
      >();
      let permissionSequence = 0,
        nativeSessionId = '',
        busy = false,
        turnHasOutput = false,
        cancelRequested = false,
        closed = false;
      const cancelPermissions = () => {
        for (const permission of permissions.values()) {
          try {
            rpc.write({ id: permission.id, result: { outcome: { outcome: 'cancelled' } } });
          } catch {
            /* closed */
          }
        }
        permissions.clear();
        emit({ type: 'permissions.cleared' });
      };
      rpc.onClose = () => {
        closed = true;
        permissions.clear();
        request.signal?.removeEventListener('abort', abort);
        emit({ type: 'closed' });
      };
      rpc.onMessage = (message) => {
        const params = object(message.params);
        const matches = params?.sessionId === nativeSessionId && nativeSessionId !== '';
        if (message.method === 'session/update' && matches && message.id === undefined) {
          const update = object(params?.update);
          // Known presentation fields only; never forward arbitrary _meta or auth data.
          if (!update) return;
          const content = object(update.content);
          if (
            ['agent_message_chunk', 'agent_thought_chunk'].includes(String(update.sessionUpdate)) &&
            content?.type === 'text'
          )
            emit({
              type: 'text',
              data: {
                text: text(content.text),
                thought: update.sessionUpdate === 'agent_thought_chunk',
              },
            });
          else if (['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate)))
            emit({
              type: 'tool',
              data: {
                id: text(update.toolCallId, 160),
                title: text(update.title, 500),
                status: text(update.status, 40),
                kind: [
                  'read',
                  'edit',
                  'delete',
                  'move',
                  'search',
                  'execute',
                  'think',
                  'fetch',
                  'other',
                ].includes(String(update.kind))
                  ? String(update.kind)
                  : undefined,
              },
            });
          else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries))
            emit({
              type: 'plan',
              data: {
                text: update.entries
                  .slice(0, 30)
                  .map((entry) => text(object(entry)?.content, 500))
                  .join('\n'),
              },
            });
          return;
        }
        if (message.id === undefined) return;
        if (message.method === 'session/request_permission' && matches && permissions.size < 16) {
          const choices = Array.isArray(params?.options)
            ? params.options.slice(0, 16).flatMap((raw) => {
                const o = object(raw);
                return o &&
                  typeof o.optionId === 'string' &&
                  o.optionId.length <= 160 &&
                  typeof o.name === 'string'
                  ? [{ id: o.optionId, label: text(o.name, 250), kind: permissionKind(o.kind) }]
                  : [];
              })
            : [];
          if (choices.length) {
            const id = String(++permissionSequence);
            permissions.set(id, {
              id: message.id,
              options: choices.map((o) => o.id),
              rejectOptions: choices
                .filter((o) => o.kind === 'reject_once' || o.kind === 'reject_always')
                .map((o) => o.id),
            });
            emit({
              type: 'permission',
              data: { id, title: text(object(params?.toolCall)?.title, 1000), options: choices },
            });
            return;
          }
        }
        rpc.write({
          id: message.id,
          error: { code: -32601, message: 'Client method not supported' },
        });
      };
      let authenticating = false;
      try {
        const initialized = object(
          await rpc.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'Cindy', version: '1' },
            clientCapabilities: {},
          }),
        );
        if (initialized?.protocolVersion !== 1) throw new NativeAgentError('protocol-error');
        if (definition.authenticateMethod) {
          authenticating = true;
          await rpc.request(
            'authenticate',
            { methodId: definition.authenticateMethod },
            definition.authenticateTimeoutMs,
          );
          authenticating = false;
        }
        const result = object(await rpc.request('session/new', { cwd: root, mcpServers: [] }));
        nativeSessionId = text(result?.sessionId, 1000);
        if (!nativeSessionId || closed) throw new NativeAgentError('startup-failed');
      } catch (error) {
        await rpc.close();
        if (authenticating && error instanceof NativeAgentError && error.code === 'timeout')
          throw new NativeAgentError('auth-unavailable');
        throw error instanceof NativeAgentError ? error : new NativeAgentError('startup-failed');
      }
      const session: AgentSession = {
        instanceId: request.instanceId,
        runtimeNodeId: request.runtimeNodeId,
        onEvent(listener) {
          listeners.add(listener);
          if (closed) listener({ type: 'closed' });
          return () => listeners.delete(listener);
        },
        async send(input) {
          if (closed) throw new NativeAgentError('closed');
          if (busy) throw new NativeAgentError('busy');
          if (!input.text.trim() || input.text.length > 32_000)
            throw new NativeAgentError('protocol-error');
          busy = true;
          turnHasOutput = false;
          cancelRequested = false;
          try {
            const result = object(
              await rpc.request(
                'session/prompt',
                { sessionId: nativeSessionId, prompt: [{ type: 'text', text: input.text }] },
                0,
              ),
            );
            // A native Agent may retain a cancelled turn internally. Do not
            // present a new, unrequested cancellation as completed work.
            if (result?.stopReason === 'cancelled' && !cancelRequested)
              throw new NativeAgentError('unexpected-cancellation');
            // MiMo can acknowledge a failed model request without an ACP error
            // or any output. Do not infer an auth cause or present it as success.
            // Its native slash-command branch can legitimately finish silently.
            if (
              definition.rejectEmptyTurn &&
              !input.text.trimStart().startsWith('/') &&
              !cancelRequested &&
              !turnHasOutput
            )
              throw new NativeAgentError('protocol-error');
          } finally {
            busy = false;
            cancelPermissions();
          }
        },
        async respondPermission(id, optionId) {
          const permission = permissions.get(id);
          if (!permission || (optionId !== null && !permission.options.includes(optionId)))
            throw new NativeAgentError('invalid-permission');
          if (optionId === null || permission.rejectOptions.includes(optionId))
            cancelRequested = true;
          rpc.write({
            id: permission.id,
            result: {
              outcome:
                optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
            },
          });
          permissions.delete(id);
          emit({ type: 'permission.resolved', data: { id } });
        },
        async stop() {
          if (closed || !busy) return;
          cancelRequested = true;
          cancelPermissions();
          rpc.write({ method: 'session/cancel', params: { sessionId: nativeSessionId } });
        },
        async close() {
          cancelPermissions();
          await rpc.close();
          listeners.clear();
        },
      };
      return session;
    },
  };
}

/** Backwards-compatible ACP entry; other protocols supply their own session driver. */
export const createNativeAcpAdapter = createNativeProcessAdapter;
