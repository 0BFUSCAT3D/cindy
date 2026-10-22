import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEBUDDY_ADAPTER_ID,
  CodeBuddyAdapterError,
  type CodeBuddySpawnProcess,
  createCodeBuddyAdapter,
  findCodeBuddyExecutable,
} from '../codebuddy.js';
import { createAgentAdapterRuntime } from '../runtime.js';
import { createNativeAcpAdapter } from '../acp.js';
import { NATIVE_AGENT_DEFINITIONS } from '../definitions.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：通过 CodeBuddy 官方 CLI 发现和 ACP session 入口，验证节点绑定、进程参数、事件流和关闭。
 * - Bug／规则依据：Agent-native 订阅必须由 Agent 自己持有；不得读取登录文件或把 Cindy provider token 注入子进程。
 * - 现有覆盖缺口：P1 注册表只验证通用发现结果，不覆盖真实适配器的官方 CLI 边界和 ACP framing。
 * - 最小失败输入：找不到 CLI、跨节点启动、缺少绝对 workspace、带 provider secret 的 spawn 环境。
 * - tier：unit；fake filesystem/process，不访问真实账号、网络或用户 Agent home。
 * - 实测耗时：单独运行本文件应低于 5 秒。
 */

class FakeCodeBuddyProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  readonly messages: Record<string, unknown>[] = [];
  holdPrompt = false;
  holdAuthentication = false;
  exitOnInputEnd = false;
  rejectMethod = '';
  rejectCode = -32000;
  rejectMessage = 'fake-private-diagnostic';
  promptStopReason = 'end_turn';
  promptId = 0;
  private input = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('finish', () => {
      if (this.exitOnInputEnd) this.emit('close', 0, null);
    });
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk;
      let newline = this.input.indexOf('\n');
      while (newline >= 0) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        this.handleRequest(JSON.parse(line) as { id: number; method: string; params?: unknown });
        newline = this.input.indexOf('\n');
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit('close', null, 'SIGTERM');
    return true;
  }

  private reply(id: number, result: unknown): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  notify(message: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  private handleRequest(request: { id: number; method: string; params?: unknown }): void {
    this.messages.push(request);
    if (request.method === this.rejectMethod) {
      this.notify({
        id: request.id,
        error: {
          code: this.rejectCode,
          message: this.rejectMessage,
          data: { token: 'fake-secret' },
        },
      });
      return;
    }
    if (request.method === 'initialize') {
      this.reply(request.id, { protocolVersion: 1, agentInfo: { name: 'CodeBuddy' } });
    } else if (request.method === 'authenticate') {
      if (this.holdAuthentication) return;
      this.reply(request.id, {});
    } else if (request.method === 'session/new') {
      this.reply(request.id, { sessionId: 'fake-session' });
    } else if (request.method === 'session/prompt') {
      this.promptId = request.id;
      if (this.holdPrompt) return;
      this.notify({
        method: 'session/update',
        params: {
          sessionId: 'fake-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        },
      });
      this.reply(request.id, { stopReason: this.promptStopReason });
    } else if (request.method === 'session/cancel') {
      if (this.promptId) this.reply(this.promptId, { stopReason: 'cancelled' });
    }
  }
}

describe('CodeBuddy adapter', () => {
  it('reports an unsolicited native cancellation instead of accepting an empty completed turn', async () => {
    // Real CodeBuddy 2.170.0 kept returning cancelled after an earlier cancellation.
    // The previous tests only cancelled an active turn; this response must reject
    // through the production send entry so the session service shows failure.
    const child = new FakeCodeBuddyProcess();
    child.holdPrompt = true;
    const adapter = createCodeBuddyAdapter({
      platform: 'linux',
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess: () => child as never,
    });
    await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
    const session = await adapter.start({
      sessionId: 'task',
      instanceId: 'codebuddy:local',
      runtimeNodeId: 'local',
      workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
    });
    try {
      const interrupted = session.send({ text: 'count' });
      await session.stop();
      await interrupted;
      child.holdPrompt = false;
      child.promptStopReason = 'cancelled';
      await expect(session.send({ text: 'continue' })).rejects.toMatchObject({
        code: 'unexpected-cancellation',
      });
    } finally {
      await session.close();
    }
  });
  it('reaps a native tool process group even when the Agent has already exited', async () => {
    // 父进程的 close 不代表工具进程组已退出；旧实现会跳过 SIGKILL 并遗留忽略 SIGTERM 的工具。
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const child = Object.assign(new FakeCodeBuddyProcess(), { pid: 42123 });
      const adapter = createCodeBuddyAdapter({
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess: () => child as never,
        closeGraceMs: 100,
      });
      await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      const session = await adapter.start({
        sessionId: 'task',
        instanceId: 'codebuddy:local',
        runtimeNodeId: 'local',
        workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
      });
      child.emit('close', 0, null);
      const closed = session.close();
      await vi.advanceTimersByTimeAsync(100);
      await closed;
      expect(kill).toHaveBeenCalledWith(-42123, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(-42123, 'SIGKILL');
      expect(kill.mock.calls.every(([pid]) => pid === -42123)).toBe(true);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('uses Windows path semantics for documented executables without invoking a shell', async () => {
    const checked: string[] = [];
    const found = await findCodeBuddyExecutable({
      platform: 'win32',
      env: { Path: 'C:\\Tools;D:\\bin' },
      accessFile: async (path) => {
        checked.push(path);
        if (path !== 'D:\\bin\\codebuddy.exe') throw new Error('missing');
      },
    });
    expect(found).toBe('D:\\bin\\codebuddy.exe');
    expect(checked).toEqual(['C:\\Tools\\codebuddy.exe', 'D:\\bin\\codebuddy.exe']);
  });

  // Windows npm creates .cmd shims, previously invisible to native discovery.
  // Unit coverage uses the real discovery/start entry with fake filesystem/process:
  // a vendor Node entry plus node.exe must spawn without cmd.exe, even with shell
  // metacharacters in paths; a missing Node runtime must remain unavailable.
  it.each([
    ['cline', 'cline/bin/cline', ['--acp'], true],
    ['cline', 'cline/bin/cline', ['--acp'], false],
    ['devin', 'devin/bin/devin.js', ['acp'], true],
    ['minimax', '@minimax-ai/code/cli.js', ['acp'], true],
    ['grok', '@xai-official/grok/bin/grok-bootstrap.js', ['agent', 'stdio'], true],
    ['snow', 'snow-ai/bundle/cli.mjs', ['--acp'], true],
    ['command-code', 'command-code/dist/index.mjs', ['acp'], true],
    ['deveco', '@deveco/deveco-code/bin/deveco', ['acp'], true],
    ['atomcode', '@atomgit.com/atomcode/bin/atomcode.js', ['acp'], true],
    ['mimo', '@mimo-ai/cli/bin/mimo', ['acp'], true],
    ['mothx', 'mothx-installer/bin/mothx', ['acp', '--mode', 'agent'], true],
    ['dsh', '@deepseek-ai/dsh/lib/bin.js', ['--profile', 'acp'], true],
  ] as const)(
    'handles Windows npm %s discovery through %s (%j; Node available=%s)',
    async (name, npmEntry, args, hasNode) => {
      const node = 'C:\\Program Files\\nodejs\\node.exe';
      const entry = win32.resolve('C:/Users/A & B/AppData/Roaming/npm/node_modules', npmEntry);
      const child = new FakeCodeBuddyProcess();
      const spawnProcess = vi.fn<CodeBuddySpawnProcess>(() => child as never);
      const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS[name], {
        platform: 'win32',
        env: {
          Path: 'C:\\Program Files\\nodejs',
          APPDATA: 'C:\\Users\\A & B\\AppData\\Roaming',
          USERPROFILE: 'C:\\Users\\A & B',
          NODE_OPTIONS: '--require unwanted',
          OPENAI_API_KEY: 'must-not-cross',
        },
        accessFile: async (candidate) => {
          if (candidate !== entry && !(hasNode && candidate === node)) throw new Error('missing');
        },
        spawnProcess,
      });
      const instances = await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      if (!hasNode) {
        expect(instances).toEqual([]);
        expect(spawnProcess).not.toHaveBeenCalled();
        return;
      }
      expect(instances[0]?.id).toBe(name + ':local');
      const session = await adapter.start({
        sessionId: 'task',
        instanceId: name + ':local',
        runtimeNodeId: 'local',
        workspace: { id: 'w', runtimeNodeId: 'local', root: 'D:\\Projects\\A & B' },
      });
      expect(spawnProcess).toHaveBeenCalledWith(
        node,
        [entry, ...args],
        expect.objectContaining({
          shell: false,
          detached: false,
          cwd: 'D:\\Projects\\A & B',
        }),
      );
      expect(spawnProcess.mock.calls[0]?.[2].env).not.toHaveProperty('NODE_OPTIONS');
      expect(spawnProcess.mock.calls[0]?.[2].env).not.toHaveProperty('OPENAI_API_KEY');
      await session.send({ text: 'hello' });
      await session.close();
      expect(child.killed).toBe(true);
    },
  );

  it.each([
    ['cursor', 100],
    ['antigravity', 180_000],
  ] as const)(
    'bounds a stalled %s native authentication and cleans up its process',
    async (name, timeoutMs) => {
      vi.useFakeTimers();
      try {
        const child = new FakeCodeBuddyProcess();
        child.holdAuthentication = true;
        const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS[name], {
          platform: 'linux',
          env: { PATH: '/fake/bin' },
          accessFile: async () => {},
          spawnProcess: () => child as never,
          requestTimeoutMs: 100,
        });
        await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
        const failed = expect(
          adapter.start({
            sessionId: 'task',
            instanceId: name + ':local',
            runtimeNodeId: 'local',
            workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
          }),
        ).rejects.toMatchObject({ code: 'auth-unavailable' });
        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(child.killed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await failed;
        expect(child.killed).toBe(true);
        expect(child.messages.some((message) => message.method === 'session/new')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('allows the native Antigravity browser login to finish after the ordinary RPC deadline', async () => {
    // 2026-10-20 real login took 35.85 s; the shared 30 s RPC deadline killed its callback.
    // Existing timeout coverage only tests a stalled login. This unit case observes session creation
    // after a 35 s native response, using virtual time and the production start entry.
    vi.useFakeTimers();
    const child = new FakeCodeBuddyProcess();
    child.holdAuthentication = true;
    const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS.antigravity, {
      platform: 'darwin',
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess: () => child as never,
    });
    await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
    const started = adapter.start({
      sessionId: 'task',
      instanceId: 'antigravity:local',
      runtimeNodeId: 'local',
      workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
    });
    void started.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(35_000);
      expect(child.killed).toBe(false);
      const auth = child.messages.find((message) => message.method === 'authenticate');
      child.notify({ id: auth?.id, result: {} });
      await expect(started).resolves.toMatchObject({ instanceId: 'antigravity:local' });
    } finally {
      await started.then(
        (session) => session.close(),
        () => {},
      );
      vi.useRealTimers();
    }
  });
  it('discovers only an installed official CLI and never starts a process', async () => {
    const checked: string[] = [];
    const executable = await findCodeBuddyExecutable({
      platform: 'linux',
      env: { PATH: '/fake/bin' },
      accessFile: async (path) => {
        checked.push(path);
        if (path !== '/fake/bin/codebuddy') throw new Error('not found');
      },
    });

    expect(executable).toBe('/fake/bin/codebuddy');
    expect(checked).toEqual(['/fake/bin/codebuddy']);
    expect(checked.some((path) => path.includes('.config') || path.includes('cookie'))).toBe(false);
  });

  it('binds a local instance to official ACP and strips Cindy provider secrets', async () => {
    const child = new FakeCodeBuddyProcess();
    const spawnProcess = vi.fn<CodeBuddySpawnProcess>(() => child as never);
    const adapter = createCodeBuddyAdapter({
      platform: 'linux',
      env: {
        PATH: '/fake/bin',
        ANTHROPIC_API_KEY: 'must-not-cross',
        CINDY_FIXTURE_TOKEN: 'must-not-cross',
        HOME: '/fake/home',
        NODE_OPTIONS: '--require untrusted',
        SAFE_RUNTIME_FLAG: 'drop',
      },
      accessFile: async (path) => {
        if (path !== '/fake/bin/codebuddy') throw new Error('not found');
      },
      spawnProcess,
      closeGraceMs: 0,
    });

    const instances = await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
    expect(instances).toEqual([
      expect.objectContaining({
        id: 'codebuddy:local',
        adapterId: CODEBUDDY_ADAPTER_ID,
        credentialBoundary: 'agent-owned',
        status: 'ready',
      }),
    ]);

    const events: unknown[] = [];
    const session = await adapter.start({
      sessionId: 'task-1',
      instanceId: 'codebuddy:local',
      runtimeNodeId: 'local',
      workspace: { id: 'workspace-1', runtimeNodeId: 'local', root: '/tmp/project' },
    });
    expect(session).toMatchObject({ instanceId: 'codebuddy:local', runtimeNodeId: 'local' });
    session.onEvent((event) => events.push(event));
    await session.send({ text: 'hello' });
    await session.stop();

    expect(spawnProcess).toHaveBeenCalledWith(
      '/fake/bin/codebuddy',
      ['--acp'],
      expect.objectContaining({
        cwd: '/tmp/project',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME: '/fake/home', PATH: '/fake/bin' },
      }),
    );
    const spawnEnv = spawnProcess.mock.calls[0]?.[2].env;
    expect(spawnEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(spawnEnv).not.toHaveProperty('CINDY_FIXTURE_TOKEN');
    expect(events).toContainEqual({ type: 'text', data: { text: 'ok', thought: false } });
    // A stop after completion must not poison the next native turn.
    expect(child.messages.some((m) => m.method === 'session/cancel')).toBe(false);
    await session.close();
    expect(child.killed).toBe(true);
  });

  // Official launch/auth contracts: an incorrect flag starts a TUI instead of ACP.
  // Exercise the production discovery/start path, not a copy of the definition table.
  it.each([
    ['opencode', 'linux', ['acp']],
    ['atomcode', 'linux', ['acp']],
    ['cursor', 'linux', ['acp']],
    ['kiro', 'linux', ['acp']],
    ['antigravity', 'darwin', []],
    ['antigravity', 'linux', ['--uid=']],
    ['gemini', 'linux', ['--acp']],
    ['copilot', 'linux', ['--acp']],
    ['goose', 'linux', ['acp']],
    ['kimi', 'linux', ['acp']],
    ['qwen', 'linux', ['--acp']],
    ['cline', 'linux', ['--acp']],
    ['droid', 'linux', ['exec', '--output-format', 'acp-daemon']],
    ['qoder', 'linux', ['--acp']],
    ['qoder-cn', 'linux', ['--acp']],
    ['devin', 'linux', ['acp']],
    ['minimax', 'linux', ['acp']],
    ['grok', 'linux', ['agent', 'stdio']],
    ['mimo', 'linux', ['acp']],
    ['omp', 'linux', ['acp']],
    ['mothx', 'linux', ['acp', '--mode', 'agent']],
    ['dsh', 'linux', ['--profile', 'acp']],
    ['hermes', 'linux', ['acp']],
    ['prime', 'linux', ['--mode', 'acp', '--no-session']],
    ['jcode', 'linux', ['acp']],
    ['fx', 'linux', ['acp']],
    ['snow', 'linux', ['--acp']],
    ['command-code', 'linux', ['acp']],
    ['ante', 'linux', ['acp']],
    ['reasonix', 'linux', ['acp']],
    ['deveco', 'darwin', ['acp']],
  ] as const)('runs %s through its official ACP command on %s', async (name, platform, args) => {
    const child = new FakeCodeBuddyProcess();
    child.exitOnInputEnd = true;
    const spawnProcess = vi.fn<CodeBuddySpawnProcess>(() => child as never);
    const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS[name], {
      platform,
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess,
    });
    const instances = await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
    if (name === 'prime' || name === 'jcode')
      expect(instances[0]?.capabilities).not.toContain('permissions');
    const session = await adapter.start({
      sessionId: 'task',
      instanceId: name + ':local',
      runtimeNodeId: 'local',
      workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
    });
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(args);
    if (name === 'droid' || name === 'qoder' || name === 'qoder-cn') {
      expect(spawnProcess.mock.calls[0]?.[0]).toBe(
        '/fake/bin/' + (name === 'qoder-cn' ? 'qodercn' : name),
      );
      // Native login stays with the selected product; starting must not switch auth methods.
      expect(child.messages.some((message) => message.method === 'authenticate')).toBe(false);
    }
    expect(child.messages[0]?.params).toMatchObject({ clientCapabilities: {} });
    if (name === 'cursor')
      expect(child.messages).toContainEqual(
        expect.objectContaining({ method: 'authenticate', params: { methodId: 'cursor_login' } }),
      );
    if (name === 'antigravity')
      expect(child.messages).toContainEqual(
        expect.objectContaining({ method: 'authenticate', params: { methodId: 'oauth-personal' } }),
      );
    await session.close();
  });

  // Prime --no-session finishes only its owned daemon worker on stdin EOF.
  // Production close must let that drain, but a stalled CLI cannot hang shutdown.
  // Existing immediate-kill coverage cannot distinguish these outcomes. Unit, fake clock/process.
  it.each(['eof', 'stalled'] as const)(
    'drains a native owned session on %s before force-close',
    async (mode) => {
      vi.useFakeTimers();
      const child = new FakeCodeBuddyProcess();
      child.exitOnInputEnd = mode === 'eof';
      const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS.prime, {
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess: () => child as never,
      });
      let session;
      try {
        await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
        session = await adapter.start({
          sessionId: 'task',
          instanceId: 'prime:local',
          runtimeNodeId: 'local',
          workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
        });
        const closing = session.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(child.stdin.writableEnded).toBe(true);
        expect(child.killed).toBe(false);
        await vi.runAllTimersAsync();
        await closing;
        expect(child.killed).toBe(mode === 'stalled');
        await expect(session.send({ text: 'after close' })).rejects.toMatchObject({
          code: 'closed',
        });
      } finally {
        const closing = session?.close();
        await vi.runAllTimersAsync();
        await closing;
        vi.useRealTimers();
      }
    },
  );

  it('does not discover Qoder through the separately installed Mainland China CLI', async () => {
    // The two official CLIs own separate account stores. Reusing qodercn as a
    // fallback for qoder would route the selected product into the wrong account.
    // Unit: exercise the real discovery entry with only the CN executable present.
    const options = {
      platform: 'linux' as const,
      env: { PATH: '/fake/bin' },
      accessFile: async (candidate: string) => {
        if (candidate !== '/fake/bin/qodercn') throw new Error('missing');
      },
    };
    const node = { id: 'local', kind: 'local' as const, status: 'online' as const };
    await expect(
      createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS.qoder, options).discover(node),
    ).resolves.toEqual([]);
    await expect(
      createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS['qoder-cn'], options).discover(node),
    ).resolves.toMatchObject([{ id: 'qoder-cn:local', credentialBoundary: 'agent-owned' }]);
  });

  // MiMo 0.1.15 without native account/model configuration returned end_turn
  // with no output, hiding the failed request. Production send must reject that
  // result on this adapter, while permitting tool-only work and explicit cancel.
  // Native slash commands such as /compact may legitimately complete silently.
  // An earlier successful turn must not mask a later empty one. Unit: fake ACP.
  it.each(['empty', 'tool', 'cancel', 'command', 'legacy-empty'] as const)(
    'handles an opt-in empty-turn check for %s after a reply',
    async (outcome) => {
      const child = new FakeCodeBuddyProcess();
      const name = outcome === 'legacy-empty' ? 'opencode' : 'mimo';
      const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS[name], {
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess: () => child as never,
      });
      await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      const session = await adapter.start({
        sessionId: 'task',
        instanceId: name + ':local',
        runtimeNodeId: 'local',
        workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
      });
      try {
        await session.send({ text: 'hello' });
        child.holdPrompt = true;
        const sent = session.send({ text: outcome === 'command' ? '  /compact  ' : 'next' });
        const checked =
          outcome === 'empty'
            ? expect(sent).rejects.toMatchObject({ code: 'protocol-error' })
            : expect(sent).resolves.toBeUndefined();
        if (outcome === 'cancel') await session.stop();
        else {
          if (outcome === 'tool')
            child.notify({
              method: 'session/update',
              params: {
                sessionId: 'fake-session',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 't',
                  kind: 'read',
                  title: 'Read file',
                  status: 'completed',
                },
              },
            });
          child.notify({ id: child.promptId, result: { stopReason: 'end_turn' } });
        }
        await checked;
      } finally {
        await session.close();
      }
    },
  );

  // fx 0.0.14 uses Invalid Request for a documented missing-login message.
  // The same code also describes protocol errors, so only its exact vendor
  // contract may become needs-auth. Unit: production startup with fake RPC.
  it.each([
    ['fx', -32600, true, 'needs-auth'],
    ['fx', -32600, false, 'protocol-error'],
    ['fx', -32603, true, 'protocol-error'],
    ['opencode', -32600, true, 'protocol-error'],
  ] as const)(
    'classifies %s login response (%s, known=%s) as %s',
    async (name, code, known, expected) => {
      const child = new FakeCodeBuddyProcess();
      child.rejectMethod = 'initialize';
      child.rejectCode = code;
      if (known)
        child.rejectMessage =
          'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.';
      const adapter = createNativeAcpAdapter(NATIVE_AGENT_DEFINITIONS[name], {
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess: () => child as never,
      });
      await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      const failure = await adapter
        .start({
          sessionId: 'task',
          instanceId: name + ':local',
          runtimeNodeId: 'local',
          workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: expected, message: expected });
      expect(child.killed).toBe(true);
      expect(JSON.stringify(failure)).not.toContain('fake-secret');
    },
  );

  // Missing native login may reject creation or the first turn. Through the
  // public adapter entry, both must retain the stable error without forwarding
  // vendor diagnostics or trying another account. Unit, fake process only.
  it.each([
    ['session/new', -32000, 'needs-auth'],
    ['session/prompt', -32000, 'needs-auth'],
    ['session/new', -32603, 'protocol-error'],
    ['session/prompt', -32603, 'protocol-error'],
  ] as const)(
    'reports native account/configuration failure at %s (%s → %s) and permits a fresh start',
    async (method, rpcCode, expectedCode) => {
      const child = new FakeCodeBuddyProcess();
      child.rejectMethod = method;
      child.rejectCode = rpcCode;
      const retry = new FakeCodeBuddyProcess();
      const spawnProcess = vi
        .fn<CodeBuddySpawnProcess>()
        .mockReturnValueOnce(child as never)
        .mockReturnValueOnce(retry as never);
      const adapter = createCodeBuddyAdapter({
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess,
      });
      await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      const request = {
        sessionId: 'task',
        instanceId: 'codebuddy:local',
        runtimeNodeId: 'local',
        workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
      };
      const session = method === 'session/prompt' ? await adapter.start(request) : undefined;
      try {
        const failure = await (
          session ? session.send({ text: 'hello' }) : adapter.start(request)
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CodeBuddyAdapterError);
        expect(failure).toMatchObject({ code: expectedCode, message: expectedCode });
        expect(JSON.stringify(failure)).not.toMatch(/fake-private-diagnostic|fake-secret/);
        expect(spawnProcess).toHaveBeenCalledTimes(1);
        expect(child.messages.some((message) => message.method === 'authenticate')).toBe(false);
      } finally {
        await session?.close();
      }
      expect(child.killed).toBe(true);
      const restarted = await adapter.start(request);
      await restarted.close();
      expect(retry.killed).toBe(true);
    },
  );

  it('keeps permission requests separate from a prompt with the same RPC id and cancels without an ack', async () => {
    const child = new FakeCodeBuddyProcess();
    child.holdPrompt = true;
    const adapter = createCodeBuddyAdapter({
      platform: 'linux',
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess: () => child as never,
    });
    await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
    const session = await adapter.start({
      sessionId: 'task',
      instanceId: 'codebuddy:local',
      runtimeNodeId: 'local',
      workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
    });
    const events: unknown[] = [];
    session.onEvent((e) => events.push(e));
    const sent = session.send({ text: 'edit' });
    child.notify({
      id: child.promptId,
      method: 'session/request_permission',
      params: {
        sessionId: 'fake-session',
        toolCall: { title: 'Edit file' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
      },
    });
    expect(events).toContainEqual({
      type: 'permission',
      data: {
        id: '1',
        title: 'Edit file',
        options: [{ id: 'yes', label: 'Allow', kind: 'allow_once' }],
      },
    });
    await expect(session.respondPermission?.('1', 'invented')).rejects.toMatchObject({
      code: 'invalid-permission',
    });
    await session.respondPermission?.('1', 'yes');
    expect(child.messages).toContainEqual({
      jsonrpc: '2.0',
      id: child.promptId,
      result: { outcome: { outcome: 'selected', optionId: 'yes' } },
    });
    await expect(session.send({ text: 'duplicate' })).rejects.toMatchObject({ code: 'busy' });
    await session.stop();
    expect(child.messages.find((m) => m.method === 'session/cancel')).not.toHaveProperty('id');
    await sent;
    await session.close();
  });

  it.each(['malformed', 'oversized', 'oversized-multibyte', 'abort'] as const)(
    'closes only this native process on %s',
    async (failure) => {
      const child = new FakeCodeBuddyProcess();
      child.holdPrompt = true;
      const adapter = createCodeBuddyAdapter({
        platform: 'linux',
        env: { PATH: '/fake/bin' },
        accessFile: async () => {},
        spawnProcess: () => child as never,
      });
      await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
      const abort = new AbortController();
      const session = await adapter.start({
        sessionId: 'task',
        instanceId: 'codebuddy:local',
        runtimeNodeId: 'local',
        signal: abort.signal,
        workspace: { id: 'w', runtimeNodeId: 'local', root: '/fake/project' },
      });
      const pending = expect(session.send({ text: 'hello' })).rejects.toMatchObject({
        code: 'closed',
      });
      try {
        if (failure === 'abort') abort.abort();
        else
          child.stdout.write(
            failure === 'malformed'
              ? 'not-json\n'
              : failure === 'oversized-multibyte'
                ? '汉'.repeat(400_000)
                : 'x'.repeat(1024 * 1024 + 1),
          );
        await Promise.resolve();
        expect(child.killed).toBe(true);
        await pending;
      } finally {
        await session.close();
        await pending;
      }
    },
  );

  it('rejects a node mismatch or missing absolute workspace before spawning', async () => {
    const spawnProcess = vi.fn<CodeBuddySpawnProcess>();
    const adapter = createCodeBuddyAdapter({
      platform: 'linux',
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess,
    });
    await adapter.discover({ id: 'local', kind: 'local', status: 'online' });

    await expect(
      adapter.start({
        sessionId: 'task-1',
        instanceId: 'codebuddy:local',
        runtimeNodeId: 'remote',
        workspace: { id: 'workspace-1', runtimeNodeId: 'remote', root: '/tmp/project' },
      }),
    ).rejects.toMatchObject({
      code: 'instance-not-discovered',
    } satisfies Partial<CodeBuddyAdapterError>);
    await expect(
      adapter.start({
        sessionId: 'task-1',
        instanceId: 'codebuddy:local',
        runtimeNodeId: 'local',
        workspace: { id: 'workspace-1', runtimeNodeId: 'local', root: 'relative/project' },
      }),
    ).rejects.toMatchObject({
      code: 'workspace-required',
    } satisfies Partial<CodeBuddyAdapterError>);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('starts through the enabled runtime only after strict route resolution', async () => {
    const child = new FakeCodeBuddyProcess();
    const adapter = createCodeBuddyAdapter({
      platform: 'linux',
      env: { PATH: '/fake/bin' },
      accessFile: async () => {},
      spawnProcess: vi.fn<CodeBuddySpawnProcess>(() => child as never),
      closeGraceMs: 0,
    });
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      runtimeNodes: [{ id: 'local', kind: 'local', status: 'online' }],
      agentAdapters: [adapter],
    });

    await runtime.discover();
    const session = await runtime.start({
      sessionId: 'task-1',
      instanceId: 'codebuddy:local',
      runtimeNodeId: 'local',
      workspace: { id: 'workspace-1', runtimeNodeId: 'local', root: '/tmp/project' },
    });

    expect(session).toMatchObject({ instanceId: 'codebuddy:local', runtimeNodeId: 'local' });
    await session.close();
  });
});
