import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapterEvent, AgentSession } from '@cindy/maker-core/agent-adapters';
import { createNativeAgentAdapter } from '../native.js';
import { NATIVE_AGENT_DEFINITIONS } from '../definitions.js';
import type { CrushAdapterOptions } from '../crush.js';

/**
 * 测试价值：createNativeAgentAdapter 的 Crush 原生 HTTP/SSE、独占进程和临时目录生命周期。
 * 依据：Crush v0.98.1 endpoints/proto；ACK 不等于完成，run_id 不能串轮，权限不能默认放行。
 * 缺口：ACP/Step/MSP 用例不经过 HTTP/SSE、私有 socket 或原生 workspace 创建。
 * 最小输入：202 后晚到终态、旧 run_id、审批与取消竞态、401/500、断流及启动失败。
 * tier：unit；内存 HTTP/进程替身，仅使用 mkdtemp 自有目录，无外网、无用户配置。
 * 独立文件原因：HTTP 流生命周期不同于已有 NDJSON fixture；单文件预算 < 5 秒。
 */
const workspaceId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
type Call = {
  options: RequestOptions;
  body: Record<string, unknown>;
  reply(status?: number, body?: unknown): void;
};
class CrushProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    this.emit('close');
    return true;
  }
}
class CrushServer {
  calls: Call[] = [];
  stream?: PassThrough;
  runId = '';
  holdPrompt = false;
  failInit = 0;
  failPrompt = 0;
  pending?: Call;
  malformedWorkspace = false;
  request = ((options: RequestOptions, receive: (response: IncomingMessage) => void) => {
    const req = new EventEmitter() as ClientRequest;
    let response: PassThrough | undefined;
    req.destroy = (error?: Error) => {
      if (error) req.emit('error', error);
      response?.destroy();
      req.emit('close');
      return req;
    };
    req.end = ((body?: string) => {
      const call: Call = {
        options,
        body: body ? JSON.parse(body) : {},
        reply: (status = 200, payload?: unknown) => {
          response = new PassThrough();
          Object.assign(response, {
            statusCode: status,
            headers: { 'content-type': 'application/json' },
          });
          receive(response as unknown as IncomingMessage);
          response.end(payload === undefined ? '' : JSON.stringify(payload));
          response.once('end', () => req.emit('close'));
        },
      };
      this.calls.push(call);
      queueMicrotask(() => {
        const path = String(options.path);
        if (path.includes('/events?')) {
          response = this.stream = new PassThrough();
          Object.assign(response, {
            statusCode: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
          receive(response as unknown as IncomingMessage);
        } else if (path === '/v1/workspaces')
          call.reply(200, {
            id: this.malformedWorkspace ? '../wrong' : workspaceId,
            config: { key: 'fake-secret' },
          });
        else if (path.endsWith('/sessions')) call.reply(200, { id: sessionId });
        // v0.98.1 requires a live subscription before selecting the client's session.
        else if (path.includes('/current-session?') && !this.stream) call.reply(409);
        else if (path.endsWith('/agent/init') && this.failInit)
          call.reply(this.failInit, { message: 'fake-secret' });
        else if (path.endsWith('/agent')) {
          this.runId = String(call.body.run_id);
          this.pending = call;
          if (!this.holdPrompt)
            call.reply(
              this.failPrompt || 202,
              this.failPrompt ? { message: 'fake-secret' } : undefined,
            );
        } else call.reply();
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as CrushAdapterOptions['requestHttp'];
  event(type: string, payload: Record<string, unknown>) {
    this.stream?.write(
      'data: ' +
        JSON.stringify({
          type,
          payload: { type: 'updated', payload: { session_id: sessionId, ...payload } },
        }) +
        '\r\n\r\n',
    );
  }
  finish(payload: Record<string, unknown> = {}) {
    this.event('run_complete', { run_id: this.runId, message_id: 'reply', ...payload });
  }
  permission() {
    this.event('permission_request', {
      id: 'approval',
      tool_call_id: 'tool',
      tool_name: 'bash',
      description: 'Run command',
      params: { command: 'pwd' },
    });
  }
}
const sessions: AgentSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});
async function start(
  server = new CrushServer(),
  platform: NodeJS.Platform = 'linux',
  failSpawn = false,
) {
  const child = new CrushProcess(),
    events: AgentAdapterEvent[] = [];
  let args: readonly string[] = [],
    spawnEnvironment: NodeJS.ProcessEnv = {};
  const adapter = createNativeAgentAdapter(NATIVE_AGENT_DEFINITIONS.crush, {
    platform,
    env: {
      PATH: platform === 'win32' ? 'C:\\fake\\bin' : '/fake/bin',
      OPENAI_API_KEY: 'fake-secret',
    },
    accessFile: async () => {},
    requestHttp: server.request,
    spawnProcess(_command, arguments_, options) {
      args = arguments_;
      spawnEnvironment = options.env;
      if (failSpawn) throw new Error('fake-secret');
      return child as never;
    },
  });
  await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
  const pending = adapter.start({
    sessionId: 'test',
    instanceId: 'crush:local',
    runtimeNodeId: 'local',
    workspace: {
      id: 'w',
      runtimeNodeId: 'local',
      root: platform === 'win32' ? 'C:\\fake\\project' : '/fake/project',
    },
  });
  return {
    pending: pending.then((session) => {
      sessions.push(session);
      session.onEvent((event) => events.push(event));
      return session;
    }),
    child,
    server,
    events,
    get args() {
      return args;
    },
    get env() {
      return spawnEnvironment;
    },
  };
}

describe('Crush native server', () => {
  it.each(['linux', 'win32'] as const)(
    'uses an owned %s endpoint, interactive permissions and cleans its data',
    async (platform) => {
      const host = await start(undefined, platform),
        session = await host.pending;
      expect(host.env).not.toHaveProperty('OPENAI_API_KEY');
      const socket = String(host.server.calls[0].options.socketPath);
      expect(host.args).toContain((platform === 'win32' ? 'npipe://' : 'unix://') + socket);
      expect(socket).toContain(platform === 'win32' ? '\\\\.\\pipe\\cindy-crush-' : 'cdy-crush-');
      expect(
        host.server.calls.every((call) => call.options.socketPath === socket && !call.options.port),
      ).toBe(true);
      expect(
        host.server.calls.find((call) => call.options.path === '/v1/workspaces')?.body,
      ).toMatchObject({ yolo: false });
      expect(
        host.server.calls.find((call) => String(call.options.path).endsWith('/agent/init'))?.body,
      ).toEqual({ interactive: true });
      const ownedDirectory = dirname(host.args[host.args.indexOf('--data-dir') + 1]!);
      await access(ownedDirectory);
      await session.close();
      expect(host.child.killed).toBe(true);
      await expect(access(ownedDirectory)).rejects.toHaveProperty('code', 'ENOENT');
    },
  );

  it('waits for its run terminal, deduplicates full message snapshots and exposes tools', async () => {
    const host = await start(),
      session = await host.pending;
    let done = false;
    const turn = session.send({ text: 'hello' }).then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(session.send({ text: 'busy' })).rejects.toMatchObject({ code: 'busy' });
    const message = {
      id: 'reply',
      role: 'assistant',
      parts: [{ type: 'text', data: { text: '你好' } }],
    };
    host.server.event('message', { ...message, session_id: 'different' });
    host.server.event('message', message);
    host.server.event('message', message);
    host.server.event('message', {
      ...message,
      parts: [...message.parts, { type: 'tool_call', data: { id: 'tool', name: 'bash' } }],
    });
    host.server.finish({ run_id: 'old-run', text: 'wrong' });
    expect(done).toBe(false);
    host.server.finish({ text: '你好！' });
    await turn;
    expect(host.events.filter((e) => e.type === 'text').map((e) => e.data)).toEqual([
      { text: '你好', thought: false },
      { text: '！', thought: false },
    ]);
    expect(host.events).toContainEqual({
      type: 'tool',
      data: { id: 'tool', title: 'bash', status: 'in_progress' },
    });
  });

  it.each(['allow', 'deny'] as const)(
    'returns %s only for the pending permission and invalidates it at completion',
    async (answer) => {
      const host = await start(),
        session = await host.pending;
      const turn = session.send({ text: 'work' });
      await Promise.resolve();
      host.server.permission();
      host.server.permission();
      const permissions = host.events.filter((e) => e.type === 'permission');
      expect(permissions).toHaveLength(1);
      const id = (permissions[0].data as { id: string }).id;
      await expect(session.respondPermission!(id, 'not-an-option')).rejects.toMatchObject({
        code: 'invalid-permission',
      });
      await session.respondPermission!(id, answer);
      expect(
        host.server.calls.find((call) => String(call.options.path).endsWith('/permissions/grant'))
          ?.body,
      ).toMatchObject({ action: answer, permission: { session_id: sessionId } });
      host.server.finish({ cancelled: answer === 'deny' });
      await turn;
      await expect(session.respondPermission!(id, answer)).rejects.toMatchObject({
        code: 'invalid-permission',
      });
    },
  );

  it('waits for acceptance before cancel, then permits a new turn without accepting the previous terminal', async () => {
    const server = new CrushServer();
    server.holdPrompt = true;
    const host = await start(server),
      session = await host.pending;
    const first = session.send({ text: 'first' });
    await Promise.resolve();
    const stopping = session.stop();
    expect(server.calls.some((call) => String(call.options.path).endsWith('/cancel'))).toBe(false);
    server.pending!.reply(202);
    await stopping;
    expect(
      server.calls.some((call) =>
        String(call.options.path).endsWith('/agent/sessions/' + sessionId + '/cancel'),
      ),
    ).toBe(true);
    const oldRun = server.runId;
    server.finish({ cancelled: true });
    await first;
    server.holdPrompt = false;
    let done = false;
    const next = session.send({ text: 'next' }).then(() => {
      done = true;
    });
    await Promise.resolve();
    server.finish({ run_id: oldRun });
    expect(done).toBe(false);
    server.finish({ text: 'ok', message_id: 'next-reply' });
    await next;
  });

  it.each([
    [401, 'init'],
    [500, 'init'],
    [401, 'prompt'],
    [500, 'prompt'],
  ] as const)(
    'reports native %s at %s without leaking native diagnostics',
    async (status, phase) => {
      const server = new CrushServer();
      if (phase === 'init') server.failInit = status;
      else server.failPrompt = status;
      const host = await start(server);
      const failing = phase === 'init' ? host.pending : (await host.pending).send({ text: 'test' });
      await expect(failing).rejects.toMatchObject({
        code: status === 401 ? 'needs-auth' : 'protocol-error',
        message: status === 401 ? 'needs-auth' : 'protocol-error',
      });
      expect(host.child.killed).toBe(true);
      await expect(
        access(dirname(host.args[host.args.indexOf('--data-dir') + 1]!)),
      ).rejects.toHaveProperty('code', 'ENOENT');
    },
  );

  it('does not let a stalled HTTP acknowledgement wait forever or replace its timeout with closed', async () => {
    const server = new CrushServer();
    server.holdPrompt = true;
    const host = await start(server),
      session = await host.pending;
    vi.useFakeTimers();
    const turn = session.send({ text: 'wait' });
    const failed = expect(turn).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(host.child.killed).toBe(true);
  });

  it('rejects malformed identities and broken SSE frames without issuing another session request', async () => {
    const server = new CrushServer();
    server.malformedWorkspace = true;
    const malformed = await start(server);
    await expect(malformed.pending).rejects.toMatchObject({ code: 'protocol-error' });
    expect(server.calls).toHaveLength(2);
    for (const frame of ['data: not-json\n\n', 'data: ' + 'x'.repeat(1024 * 1024)]) {
      const host = await start(),
        session = await host.pending;
      const failed = expect(session.send({ text: 'test' })).rejects.toMatchObject({
        code: 'closed',
      });
      await Promise.resolve();
      host.server.stream!.write(frame);
      await failed;
      expect(host.child.killed).toBe(true);
    }
  });

  it('fails a turn on provider errors, connection loss and unsupported questions rather than hanging', async () => {
    for (const fault of ['provider', 'disconnect', 'question'] as const) {
      const host = await start(),
        session = await host.pending;
      const turn = session.send({ text: 'work' });
      const failed = expect(turn).rejects.toMatchObject({
        code: fault === 'disconnect' ? 'closed' : 'protocol-error',
      });
      await Promise.resolve();
      if (fault === 'provider') host.server.finish({ error: 'fake-secret' });
      if (fault === 'disconnect') host.server.stream!.destroy();
      if (fault === 'question')
        host.server.event('question_batch_request', { id: 'batch', questions: [{ type: 'text' }] });
      await failed;
      expect(host.events.some((e) => JSON.stringify(e).includes('fake-secret'))).toBe(false);
      await session.close();
    }
  });

  it('isolates two servers and removes temporary data even when process launch fails', async () => {
    const a = await start(),
      first = await a.pending,
      b = await start(),
      second = await b.pending;
    expect(a.server.calls[0].options.socketPath).not.toBe(b.server.calls[0].options.socketPath);
    await first.close();
    expect(b.child.killed).toBe(false);
    const turn = second.send({ text: 'still alive' });
    await Promise.resolve();
    b.server.finish({ text: 'ok' });
    await turn;
    const broken = await start(undefined, 'linux', true);
    await expect(broken.pending).rejects.toMatchObject({ code: 'startup-failed' });
    await expect(
      access(dirname(broken.args[broken.args.indexOf('--data-dir') + 1]!)),
    ).rejects.toHaveProperty('code', 'ENOENT');
  });
});
