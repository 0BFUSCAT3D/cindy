import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@cindy/maker-core/agent-adapters';
import { createNativeAgentAdapter } from '../native.js';
import { NATIVE_AGENT_DEFINITIONS } from '../definitions.js';

/**
 * 测试价值：生产 createNativeAgentAdapter 入口的原生 Step RPC / Muse MSP 合同。
 * 依据：官方 rpc.md / MSP conformance traces；ACK 不等于终态，审批不得跨阶段或跨轮。
 * 缺口：已有 ACP 用例的 prompt response 就是终态，不能覆盖这两个事件驱动协议。
 * 最小输入：ACK 后无终态、agent_end 后重试、两种审批投递、旧 turn 的晚到完成事件。
 * tier：unit，内存管道替代原生进程，不读取账号、不调用网络；单文件预算 < 5 秒。
 */
type Frame = {
  [key: string]: unknown;
  id?: string | number;
  type?: string;
  method?: string;
  params?: {
    [key: string]: unknown;
    clientInfo?: { name?: string };
    commandId?: string;
    choiceId?: string;
  };
};
class NativeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  frames: Frame[] = [];
  held: Frame | undefined;
  holdPrompt = false;
  rejectPrompt = false;
  badHandshake = false;
  exitOnHandshake = false;
  holdApproval = false;
  killed = false;
  turnId = '';
  constructor(readonly protocol: 'stepcode' | 'muse') {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('finish', () => this.emit('close'));
    let buffer = '';
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let n: number;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
        this.frames.push(frame);
        const method = frame.type ?? frame.method;
        if (method === 'get_state')
          this.reply(
            frame,
            this.badHandshake
              ? {}
              : {
                  isStreaming: false,
                  isCompacting: false,
                  pendingMessageCount: 0,
                },
          );
        else if (method === 'initialize') {
          // Muse 1.4.11 refuses uppercase client names before creating a session.
          if (!/^[a-z0-9_]+$/.test(frame.params?.clientInfo?.name ?? ''))
            this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32602 } });
          else this.reply(frame, { schema: { version: this.badHandshake ? 2 : 1 } });
        } else if (method === 'session/start')
          this.reply(frame, { session: { sessionId: 'native' } });
        else if (method === 'prompt' || method === 'turn/start') {
          this.held = frame;
          if (!this.holdPrompt) this.accept();
        } else if (
          method &&
          ['abort', 'turn/cancel', 'approval/decide'].includes(method) &&
          !(method === 'approval/decide' && this.holdApproval)
        )
          this.reply(frame, { status: 'accepted' });
      }
    });
  }
  kill() {
    this.killed = true;
    this.emit('close');
    return true;
  }
  write(frame: Frame) {
    this.stdout.write(JSON.stringify(frame) + '\n');
  }
  reply(frame: Frame, result: unknown) {
    this.write(
      this.protocol === 'stepcode'
        ? { type: 'response', id: frame.id, command: frame.type, success: true, data: result }
        : { jsonrpc: '2.0', id: frame.id, result },
    );
    if (
      this.exitOnHandshake &&
      ['get_state', 'session/start'].includes(frame.type ?? frame.method ?? '')
    )
      this.emit('close');
  }
  accept() {
    const frame = this.held!;
    this.held = undefined;
    if (this.rejectPrompt) {
      this.write(
        this.protocol === 'stepcode'
          ? { type: 'response', id: frame.id, success: false, error: 'fake-private-key' }
          : { jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'fake-private-key' } },
      );
      return;
    }
    this.turnId = frame.params?.commandId ?? '';
    this.reply(frame, {
      commandId: this.turnId,
      status: 'accepted',
      disposition: 'started',
      turnId: this.turnId,
    });
    if (this.protocol === 'muse')
      this.event('turn/started', { commandId: this.turnId, turnId: this.turnId });
  }
  event(method: string, params: Frame = {}) {
    this.write(
      this.protocol === 'stepcode'
        ? { type: method, ...params }
        : {
            jsonrpc: '2.0',
            method,
            params: { sessionId: 'native', turnId: this.turnId, ...params },
          },
    );
  }
  output(value = 'ok') {
    if (this.protocol === 'stepcode')
      this.event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: value } });
    else
      this.event('item/completed', {
        item: { itemId: 'reply', turnId: this.turnId, kind: 'agentMessage', text: value },
      });
  }
  complete() {
    this.event(this.protocol === 'stepcode' ? 'agent_settled' : 'turn/completed', {
      terminal: 'completed',
    });
  }
}
const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});
async function start(protocol: 'stepcode' | 'muse', child = new NativeProcess(protocol)) {
  const adapter = createNativeAgentAdapter(NATIVE_AGENT_DEFINITIONS[protocol], {
    platform: 'linux',
    env: { HOME: '/fake/home', PATH: '/fake/bin', OPENAI_API_KEY: 'fake-secret' },
    accessFile: async () => {},
    spawnProcess: () => child as never,
  });
  await adapter.discover({ id: 'local', kind: 'local', status: 'online' });
  const session = await adapter.start({
    sessionId: 'task',
    instanceId: protocol + ':local',
    runtimeNodeId: 'local',
    workspace: { id: 'workspace', runtimeNodeId: 'local', root: '/fake/project' },
  });
  sessions.push(session);
  const events: { type: string; data: Record<string, string> }[] = [];
  session.onEvent((event) =>
    events.push({ type: event.type, data: event.data as Record<string, string> }),
  );
  return { child, session, events };
}

describe('native event protocols', () => {
  it.each(['stepcode', 'muse'] as const)(
    '%s rejects startup when the native process exits with its handshake response',
    async (protocol) => {
      const child = new NativeProcess(protocol);
      child.exitOnHandshake = true;
      await expect(start(protocol, child)).rejects.toMatchObject({ code: 'closed' });
    },
  );
  it.each(['stepcode', 'muse'] as const)(
    '%s waits for terminal events and rejects concurrent input',
    async (protocol) => {
      const { session, child } = await start(protocol);
      let done = false;
      const pending = session.send({ text: 'hello' }).then(() => {
        done = true;
      });
      await expect(session.send({ text: 'second' })).rejects.toMatchObject({ code: 'busy' });
      child.event('agent_end');
      await Promise.resolve();
      expect(done).toBe(false);
      child.output();
      child.complete();
      await pending;
      expect(done).toBe(true);
      const second = session.send({ text: 'again' });
      child.output();
      child.complete();
      await second;
    },
  );
  it.each(['stepcode', 'muse'] as const)(
    '%s hides missing-configuration diagnostics and allows a subsequent request',
    async (protocol) => {
      const { session, child, events } = await start(protocol);
      child.rejectPrompt = true;
      await expect(session.send({ text: 'hello' })).rejects.toMatchObject({
        code: 'protocol-error',
        message: 'protocol-error',
      });
      expect(JSON.stringify(events)).not.toContain('fake-private-key');
      child.rejectPrompt = false;
      const pending = session.send({ text: 'again' });
      child.output();
      child.complete();
      await pending;
    },
  );
  it.each(['stepcode', 'muse'] as const)(
    '%s rejects an incompatible handshake and closes its process',
    async (protocol) => {
      const child = new NativeProcess(protocol);
      child.badHandshake = true;
      await expect(start(protocol, child)).rejects.toMatchObject({ code: 'protocol-error' });
      expect(child.stdin.writableEnded).toBe(true);
    },
  );
  it.each(['stepcode', 'muse'] as const)(
    '%s closes pending submission and rejects later input',
    async (protocol) => {
      const { session, child } = await start(protocol);
      child.holdPrompt = true;
      const pending = session.send({ text: 'hello' });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'closed' });
      await session.close();
      await rejected;
      await expect(session.send({ text: 'again' })).rejects.toMatchObject({ code: 'closed' });
    },
  );
  it.each(['stepcode', 'muse'] as const)(
    '%s cancels only the accepted turn, waits for termination and then permits another',
    async (protocol) => {
      const { session, child } = await start(protocol);
      child.holdPrompt = true;
      const pending = session.send({ text: 'hello' });
      const stopped = session.stop();
      child.accept();
      await stopped;
      expect(
        child.frames.some(
          (f) => (f.method ?? f.type) === (protocol === 'muse' ? 'turn/cancel' : 'abort'),
        ),
      ).toBe(true);
      await expect(session.send({ text: 'too soon' })).rejects.toMatchObject({ code: 'busy' });
      child.event(protocol === 'stepcode' ? 'agent_settled' : 'turn/completed', {
        terminal: 'cancelled',
      });
      await pending;
      child.holdPrompt = false;
      const next = session.send({ text: 'again' });
      child.output();
      child.complete();
      await next;
    },
  );
  it('discovers Step only in its documented installation, not the Smallstep certificate CLI', async () => {
    const adapter = createNativeAgentAdapter(NATIVE_AGENT_DEFINITIONS.stepcode, {
      platform: 'linux',
      env: { HOME: '/fake/home', PATH: '/smallstep' },
      accessFile: async (path) => {
        if (path !== '/smallstep/step') throw new Error('missing');
      },
    });
    expect(await adapter.discover({ id: 'local', kind: 'local', status: 'online' })).toEqual([]);
  });
  it('waits through Step retries and surfaces a final failed or empty turn', async () => {
    const { session, child } = await start('stepcode');
    const first = session.send({ text: 'retry' });
    child.event('message_end', {
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'fake-secret' },
    });
    child.event('agent_end', { willRetry: true });
    child.output();
    child.event('message_end', { message: { role: 'assistant', stopReason: 'stop' } });
    child.complete();
    await first;
    const failed = session.send({ text: 'fail' });
    child.complete();
    await expect(failed).rejects.toMatchObject({ code: 'protocol-error' });
  });
  it('answers Step confirmations and native selection values without allowing stale choices', async () => {
    const { session, child, events } = await start('stepcode');
    const pending = session.send({ text: 'confirm' });
    child.event('extension_ui_request', { id: 'native-confirm', method: 'confirm', title: 'Run?' });
    const permission = events.find((event) => event.type === 'permission')!.data;
    await expect(session.respondPermission!(permission.id, 'unknown')).rejects.toMatchObject({
      code: 'invalid-permission',
    });
    await session.respondPermission!(permission.id, 'no');
    expect(child.frames.at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'native-confirm',
      confirmed: false,
    });
    await expect(session.respondPermission!(permission.id, 'yes')).rejects.toMatchObject({
      code: 'invalid-permission',
    });
    child.complete();
    await pending;
    const next = session.send({ text: 'select' });
    child.event('extension_ui_request', {
      id: 'native-select',
      method: 'select',
      options: ['Choice A', 'Choice B'],
    });
    const select = events.filter((event) => event.type === 'permission').at(-1)!.data;
    await session.respondPermission!(select.id, '1');
    expect(child.frames.at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'native-select',
      value: 'Choice B',
    });
    child.output();
    child.complete();
    await next;
  });
  it('closes Step on unsupported free-form input instead of leaving an invisible question', async () => {
    const { session, child } = await start('stepcode');
    const pending = session.send({ text: 'input' });
    child.event('extension_ui_request', { id: 'input', method: 'input' });
    await expect(pending).rejects.toMatchObject({ code: 'protocol-error' });
    await expect(session.send({ text: 'again' })).rejects.toMatchObject({ code: 'closed' });
  });
  it('invalidates a Step permission immediately on termination, even before the prompt ACK', async () => {
    const { session, child, events } = await start('stepcode');
    child.holdPrompt = true;
    const pending = session.send({ text: 'work' });
    // Keep cleanup rejections handled if this regression fails before the ACK.
    void pending.catch(() => {});
    child.event('extension_ui_request', { id: 'approval', method: 'confirm', title: 'Run?' });
    const id = events.find((event) => event.type === 'permission')!.data.id;
    child.output();
    child.complete();
    await expect(session.respondPermission!(id, 'yes')).rejects.toMatchObject({
      code: 'invalid-permission',
    });
    expect(events.at(-1)?.type).toBe('permissions.cleared');
    child.accept();
    await pending;
  });
  it('projects Muse deltas and final snapshots once, ignoring old turns and other sessions', async () => {
    const { session, child, events } = await start('muse');
    const pending = session.send({ text: 'hello' });
    const current = child.turnId;
    expect(current).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    child.event('item/started', {
      item: { itemId: 'reply', turnId: current, kind: 'agentMessage', text: '' },
    });
    child.event('item/delta', { itemId: 'reply', field: 'text', delta: 'hello' });
    child.output('hello world');
    child.complete();
    await pending;
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.data.text)
        .join(''),
    ).toBe('hello world');
    const next = session.send({ text: 'again' });
    child.event('turn/completed', { turnId: current, terminal: 'failed' });
    child.event('turn/completed', { sessionId: 'another-session', terminal: 'failed' });
    child.output('again');
    child.complete();
    await next;
  });
  it('fails Muse on native terminal failure or unrequested cancellation, without private diagnostics', async () => {
    const { session, child, events } = await start('muse');
    for (const [terminal, code] of [
      ['failed', 'protocol-error'],
      ['cancelled', 'unexpected-cancellation'],
    ]) {
      const pending = session.send({ text: 'try' });
      child.event('turn/completed', { terminal, error: { message: 'fake-private-key' } });
      await expect(pending).rejects.toMatchObject({ code });
    }
    expect(JSON.stringify(events)).not.toContain('fake-private-key');
  });
  it('deduplicates Muse approval deliveries, binds stage IDs and acknowledges native server requests', async () => {
    const { session, child, events } = await start('muse');
    const pending = session.send({ text: 'write' });
    const approval = {
      sessionId: 'native',
      turnId: child.turnId,
      approvalId: 'approval',
      toolName: 'write_file',
      currentRequirementId: { approvalId: 'approval', sourceIndex: 0 },
      availableChoices: [
        { choiceId: 'allow_once', label: 'Allow once', decision: 'approved' },
        { choiceId: 'abort', label: 'Reject', decision: 'abort' },
      ],
    };
    child.event('approval/requested', approval);
    child.write({ jsonrpc: '2.0', id: 100, method: 'approval/request', params: approval });
    expect(events.filter((e) => e.type === 'permission')).toHaveLength(1);
    expect(child.frames).toContainEqual({ jsonrpc: '2.0', id: 100, result: {} });
    const first = events.find((e) => e.type === 'permission')!.data.id;
    // MSP updates have no turnId; their known approval identity binds them to this turn.
    child.event('approval/updated', {
      ...approval,
      turnId: undefined,
      currentRequirementId: { approvalId: 'approval', sourceIndex: 1 },
    });
    await expect(session.respondPermission!(first, 'allow_once')).rejects.toMatchObject({
      code: 'invalid-permission',
    });
    const second = events.filter((e) => e.type === 'permission').at(-1)!.data.id;
    await session.respondPermission!(second, 'allow_once');
    expect(child.frames.at(-1)?.params).toMatchObject({
      choiceId: 'allow_once',
      requirementId: { approvalId: 'approval', sourceIndex: 1 },
    });
    child.event('approval/requested', approval);
    expect(events.filter((e) => e.type === 'permission')).toHaveLength(2);
    child.output();
    child.complete();
    await pending;
  });
  it('sends the native Muse rejection choice when a pending approval is dismissed', async () => {
    const { session, child, events } = await start('muse');
    const pending = session.send({ text: 'write' });
    child.event('approval/requested', {
      approvalId: 'approval',
      toolName: 'write_file',
      currentRequirementId: { approvalId: 'approval', sourceIndex: 0 },
      availableChoices: [{ choiceId: 'abort', label: 'Reject', decision: 'abort' }],
    });
    await session.respondPermission!(events.find((e) => e.type === 'permission')!.data.id, null);
    expect(child.frames.at(-1)?.params?.choiceId).toBe('abort');
    child.event('turn/completed', { terminal: 'cancelled' });
    await pending;
  });
  it('does not fail a new Muse turn when the previous turn receives a late approval error', async () => {
    const { session, child } = await start('muse');
    const pending = session.send({ text: 'first' });
    child.event('approval/requested', {
      approvalId: 'approval',
      toolName: 'write_file',
      currentRequirementId: { approvalId: 'approval', sourceIndex: 0 },
      availableChoices: [{ choiceId: 'allow', label: 'Allow', decision: 'approved' }],
    });
    child.holdApproval = true;
    const answer = session.respondPermission!('1', 'allow');
    const answerFrame = child.frames.at(-1)!;
    child.complete();
    await pending;
    const next = session.send({ text: 'second' }).then(
      () => 'completed',
      (error: { code: string }) => error.code,
    );
    child.write({ jsonrpc: '2.0', id: answerFrame.id, error: { code: -32603 } });
    await expect(answer).rejects.toMatchObject({ code: 'protocol-error' });
    child.output();
    child.complete();
    expect(await next).toBe('completed');
  });
});
