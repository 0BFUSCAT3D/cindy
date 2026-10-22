import { describe, expect, it, vi } from 'vitest';
import { resolveRemoteText } from '@cindy/device-link';
import type {
  AgentAdapter,
  AgentAdapterEvent,
  AgentSession,
} from '@cindy/maker-core/agent-adapters';
import { createAgentAdapterRuntime } from '../runtime.js';
import { createAdapterSessionService } from '../sessions.js';
import { agentResourceRef, createAgentResourceProvider } from '../resources.js';

/**
 * 测试价值
 * - 生产入口与结果：运行服务 + Remote Resource provider；验证任务去重、权限与跨设备隔离。
 * - 规则依据：默认关闭、仅明确选中的原生 Agent 执行；断线不能重放或影响另一控制端。
 * - 覆盖缺口：ACP 测试只覆盖单个原生进程，不覆盖宿主异步启动、撤权和同账号生命周期。
 * - 最小失败输入：并发重复 start、同 requestId 不同正文、启动期间切账号、两控制端一端失联。
 * - tier：unit，内存适配器 + fake clock；无账号、磁盘、网络和真实进程。
 */
function fixture(enabled = true) {
  let current = true,
    now = 0;
  const allowed = new Set(['local', 'phone', 'desktop']);
  const sessions: {
    session: AgentSession;
    emit: (e: AgentAdapterEvent) => void;
    finish: () => void;
  }[] = [];
  const adapter: AgentAdapter = {
    id: 'fake',
    kind: 'agent-native',
    async discover(node) {
      return [
        {
          id: 'fake:local',
          adapterId: 'fake',
          runtimeNodeId: node.id,
          displayName: 'Native',
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: ['acp'],
        },
      ];
    },
    start: vi.fn(async (request) => {
      let listener: (e: AgentAdapterEvent) => void = () => {};
      let finish = () => {};
      const session: AgentSession = {
        instanceId: request.instanceId,
        runtimeNodeId: request.runtimeNodeId,
        onEvent(fn) {
          listener = fn;
          return () => {
            listener = () => {};
          };
        },
        send: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
        stop: vi.fn(async () => {}),
        close: vi.fn(async () => {
          finish();
          listener({ type: 'closed' });
        }),
        respondPermission: vi.fn(async (id, option) => {
          if (option !== 'allow' && option !== null) throw new Error('invalid');
          listener({ type: 'permission.resolved', data: { id } });
        }),
      };
      sessions.push({ session, emit: (e) => listener(e), finish: () => finish() });
      return session;
    }),
  };
  const runtime = createAgentAdapterRuntime({ enabled, agentAdapters: [adapter] });
  const validateWorkspace = vi.fn(async (root: string) => root);
  const service = createAdapterSessionService({
    runtime,
    isCurrent: () => current,
    isControllerAllowed: (c) => allowed.has(c),
    now: () => now,
    listWorkspaces: async () => [{ id: 'project', label: 'Project', root: '/fake/private/path' }],
    validateWorkspace,
  });
  const input = { requestId: 'create-1', instanceId: 'fake:local', workspaceId: 'project' };
  const start = async (controller = 'phone', requestId = 'create-1') => {
    await service.catalog(controller);
    const view = await service.start(controller, { ...input, requestId });
    await Promise.resolve();
    await Promise.resolve();
    return view;
  };
  const provider = createAgentResourceProvider({
    enabled: () => enabled,
    service: () => service,
    guard: (controller) => () => {
      if (!current || !allowed.has(controller)) throw new Error('denied');
    },
  });
  return {
    service,
    runtime,
    adapter,
    sessions,
    input,
    start,
    provider,
    allowed,
    validateWorkspace,
    setCurrent: (value: boolean) => {
      current = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
const client = { protocolVersion: 1, primitives: ['text', 'form'], locale: 'zh-CN' };

describe('native Agent task host', () => {
  it('localizes host-created confirmation choices while retaining native Agent option labels', async () => {
    // Step RPC supplies confirm semantics but no translated yes/no labels. The
    // same resource form must work on the viewing phone's locale, not the host's.
    const f = fixture(),
      run = await f.start();
    f.sessions[0]!.emit({
      type: 'permission',
      data: {
        id: 'confirm',
        title: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes', labelKey: 'yes' },
          { id: 'no', label: 'No', labelKey: 'no' },
          { id: 'native', label: 'Native option' },
        ],
      },
    });
    for (const [locale, yes, no] of [
      ['en', 'Yes', 'No'],
      ['zh-CN', '是', '否'],
      ['zh-TW', '是', '否'],
      ['ja', 'はい', 'いいえ'],
      ['ko', '예', '아니요'],
    ]) {
      const resource = await f.provider.get!(
        { controllerDeviceId: 'phone' },
        {
          client: { ...client, locale },
          ref: agentResourceRef(run.id),
        },
      );
      const options = resource.actions?.find((action) => action.id === 'permission:confirm')
        ?.fields?.[0]?.options;
      expect(options?.map((option) => resolveRemoteText(option.label, locale))).toEqual([
        yes,
        no,
        'Native option',
      ]);
    }
    await f.service.dispose();
    f.runtime.dispose();
  });
  it.each(['closing', 'starting'] as const)(
    'waits for native cleanup during disposal while %s',
    async (phase) => {
      // 退出/停用必须等在途 close 或已取消的 start 完成清理，不能因 abort 已发出就提前报告完成。
      vi.useFakeTimers();
      const f = fixture();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closing: Promise<unknown> | undefined;
      try {
        if (phase === 'starting') {
          const originalStart = vi.mocked(f.adapter.start).getMockImplementation()!;
          vi.mocked(f.adapter.start).mockImplementation(async (request) => {
            const session = await originalStart(request);
            await pending;
            return session;
          });
          await f.start();
        } else {
          const run = await f.start();
          vi.mocked(f.sessions[0]!.session.close).mockImplementation(() => pending);
          closing = f.service.close('phone', run.id);
        }
        let disposed = false;
        const disposal = f.service.dispose().then(() => {
          disposed = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(disposed).toBe(false);
        release();
        await disposal;
        await closing?.catch(() => {});
        expect(f.sessions[0]!.session.close).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await closing?.catch(() => {});
        await f.service.dispose();
        f.runtime.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('stays inert while disabled and never changes an old provider route', async () => {
    const f = fixture(false);
    await expect(f.service.catalog()).rejects.toMatchObject({ code: 'disabled' });
    const root = await f.provider.get!(
      { controllerDeviceId: 'local' },
      { client, ref: agentResourceRef('catalog') },
    );
    expect(root.actions).toEqual([]);
    expect(f.adapter.start).not.toHaveBeenCalled();
    f.runtime.dispose();
  });
  it('deduplicates concurrent starts and rejects raw paths or changed request identities', async () => {
    const f = fixture();
    await f.service.catalog('phone');
    const views = await Promise.all([
      f.service.start('phone', f.input),
      f.service.start('phone', f.input),
    ]);
    expect(views[0]?.id).toBe(views[1]?.id);
    expect(f.adapter.start).toHaveBeenCalledTimes(1);
    await expect(
      f.service.start('phone', { ...f.input, workspaceId: '/fake/path' }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(
      f.service.start('phone', { ...f.input, instanceId: 'another' }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await f.service.dispose();
    f.runtime.dispose();
  });
  it('isolates controller reads, sends and permission decisions', async () => {
    const f = fixture(),
      run = await f.start();
    expect(() => f.service.get('desktop', run.id)).toThrow('not-found');
    expect(f.service.list('desktop')).toEqual([]);
    f.sessions[0]!.emit({
      type: 'permission',
      data: { id: '1', title: 'Edit', options: [{ id: 'allow', label: 'Allow' }] },
    });
    await expect(
      f.service.permission('desktop', run.id, { permissionId: '1', optionId: 'allow' }),
    ).rejects.toThrow('not-found');
    await f.service.permission('phone', run.id, { permissionId: '1', optionId: 'allow' });
    expect(f.service.get('phone', run.id).permissions).toEqual([]);
    await f.service.dispose();
    f.runtime.dispose();
  });
  it('does not replay an acknowledged message or allow another payload under the same id', async () => {
    const f = fixture(),
      run = await f.start();
    const input = { requestId: 'message-1', text: 'hello' };
    f.service.send('phone', run.id, input);
    f.service.send('phone', run.id, input);
    expect(() => f.service.send('phone', run.id, { ...input, text: 'different' })).toThrow(
      'invalid-input',
    );
    expect(f.sessions[0]!.session.send).toHaveBeenCalledTimes(1);
    f.sessions[0]!.emit({ type: 'text', data: { text: 'x'.repeat(70_000) } });
    const view = f.service.get('phone', run.id);
    expect(view.transcript.length).toBe(60_000);
    expect(view.truncated).toBe(true);
    await f.service.dispose();
    f.runtime.dispose();
  });
  it('rechecks owner and revocation after directory validation before spawning', async () => {
    const f = fixture();
    await f.service.catalog('phone');
    f.validateWorkspace.mockImplementation(async (root) => {
      f.allowed.delete('phone');
      return root;
    });
    await expect(f.service.start('phone', f.input)).rejects.toThrow('unavailable');
    expect(f.adapter.start).not.toHaveBeenCalled();
    f.allowed.add('phone');
    f.validateWorkspace.mockImplementation(async (root) => {
      f.setCurrent(false);
      return root;
    });
    await expect(f.service.start('phone', f.input)).rejects.toThrow('stale');
    expect(f.adapter.start).not.toHaveBeenCalled();
    await f.service.dispose();
    f.runtime.dispose();
  });
  it('reaps an abandoned controller without stopping another controller', async () => {
    const f = fixture(),
      phone = await f.start(),
      desktop = await f.start('desktop');
    f.setNow(180_001);
    f.service.get('desktop', desktop.id);
    f.service.reap((controller) => f.allowed.has(controller));
    expect(f.service.get('phone', phone.id).state).toBe('closed');
    expect(f.service.get('desktop', desktop.id).state).toBe('idle');
    expect(f.sessions[1]!.session.close).not.toHaveBeenCalled();
    await f.service.dispose();
    f.runtime.dispose();
  });
  it('force closes a hung cancellation after its grace period', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        run = await f.start();
      f.service.send('phone', run.id, { requestId: 'm1', text: 'work' });
      await f.service.stop('phone', run.id);
      expect(f.service.get('phone', run.id).state).toBe('stopping');
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.service.get('phone', run.id).state).toBe('closed');
      expect(f.sessions[0]!.session.close).toHaveBeenCalledTimes(1);
      await f.service.dispose();
      f.runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses the same opaque resource actions remotely without exposing host paths', async () => {
    const f = fixture(),
      ctx = { controllerDeviceId: 'phone' };
    const root = await f.provider.get!(ctx, { client, ref: agentResourceRef('catalog') });
    expect(JSON.stringify(root)).not.toContain('/fake/private/path');
    expect(root.actions?.[0]?.fields?.[0]?.options?.[0]?.value).toBe('fake:local');
    const created = await f.provider.invoke!(ctx, {
      client,
      collectionId: 'agent-adapters',
      resourceRef: agentResourceRef('catalog'),
      actionId: 'start',
      input: f.input,
    });
    expect(created.effects[0]).toMatchObject({ kind: 'navigate', target: { kind: 'resource' } });
    const list = await f.provider.list(ctx, { client, collectionId: 'agent-adapters' });
    expect(list.items).toHaveLength(2);
    expect(
      await f.provider.list(
        { controllerDeviceId: 'desktop' },
        { client, collectionId: 'agent-adapters' },
      ),
    ).toMatchObject({ items: [expect.objectContaining({ ref: agentResourceRef('catalog') })] });
    await f.service.dispose();
    f.runtime.dispose();
  });
});
