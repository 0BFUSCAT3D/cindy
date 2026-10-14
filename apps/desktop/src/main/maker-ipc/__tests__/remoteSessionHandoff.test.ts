import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import {
  localSessionIdOf,
  parseRemoteSessionTarget,
  sendToRemoteSession,
  type RemoteSessionHandoffDeps,
} from '../remoteSessionHandoff';

const studio = {
  deviceId: 'studio',
  name: 'Mac Studio',
  isSelf: false,
  online: true,
  controlEnabled: true,
  remoteControlEnabled: true,
  platform: 'darwin',
} as DeviceLinkDeviceView;

const row = {
  id: 'task-1',
  title: '伙伴群聊手机端',
  status: 'active',
  agentKind: 'codex',
  workingDir: '/repo',
  model: 'gpt-5',
  permissionMode: 'auto',
  userSendAt: Date.UTC(2026, 9, 14),
};

function setup(
  overrides: {
    device?: Partial<DeviceLinkDeviceView> | null;
    get?: () => Promise<InvokeResultPayload>;
    enqueue?: (args: unknown[]) => Promise<InvokeResultPayload>;
  } = {},
) {
  const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
    if (channel === 'local-db:sessions:get')
      return overrides.get ? overrides.get() : ({ ok: true, result: row } as InvokeResultPayload);
    if (channel === 'maker:input:enqueue')
      return overrides.enqueue
        ? overrides.enqueue(args)
        : ({ ok: true, result: { sessionId: 'task-1', pendingQueue: [] } } as InvokeResultPayload);
    throw new Error(`unexpected ${channel}`);
  });
  const deps: RemoteSessionHandoffDeps = {
    listDevices: async () => ({
      devices: overrides.device === null ? [] : [{ ...studio, ...overrides.device }],
    }),
    invoke,
    captureAccess: () => () => undefined,
    createId: () => 'client-1',
    now: () => Date.UTC(2026, 9, 14, 8),
  };
  const send = () =>
    sendToRemoteSession(deps, {
      target: { deviceId: 'studio', sessionId: 'task-1' },
      message: '请核对链接格式',
      sender: { sessionId: 'sender-1', title: '实现群邀请链接网页落地页' },
    });
  return { invoke, send, deps };
}

describe('remote session target', () => {
  it('routes only qualified ids of other devices', () => {
    expect(parseRemoteSessionTarget('studio::task-1', 'mbp')).toEqual({
      deviceId: 'studio',
      sessionId: 'task-1',
    });
    expect(parseRemoteSessionTarget('task-1', 'mbp')).toBeNull();
    expect(parseRemoteSessionTarget('mbp::task-1', 'mbp')).toBeNull();
    expect(parseRemoteSessionTarget('local::task-1', 'mbp')).toBeNull();
    expect(parseRemoteSessionTarget('studio::', 'mbp')).toBeNull();
    expect(localSessionIdOf('mbp::task-1', 'mbp')).toBe('task-1');
    expect(localSessionIdOf('local::task-1', 'mbp')).toBe('task-1');
    expect(localSessionIdOf('task-1', 'mbp')).toBe('task-1');
  });
});

describe('sendToRemoteSession', () => {
  it('enqueues a durable message carrying the sending task', async () => {
    const { invoke, send } = setup();
    await expect(send()).resolves.toEqual({
      ok: true,
      targetSessionId: 'studio::task-1',
      agentKind: 'codex',
      wakeKind: 'resumed',
      targetTitle: '伙伴群聊手机端',
      targetLastUserSendAt: '2026-10-14T00:00:00.000Z',
    });
    const [deviceId, channel, [sessionId, item]] = invoke.mock.calls[1] as [
      string,
      string,
      [string, Record<string, unknown>],
    ];
    expect([deviceId, channel, sessionId]).toEqual(['studio', 'maker:input:enqueue', 'task-1']);
    expect(item).toMatchObject({
      clientId: 'client-1',
      durableDelivery: true,
      text: '请核对链接格式',
      persistedContent: '请核对链接格式',
      createOpts: { agentKind: 'codex', workingDir: '/repo', model: 'gpt-5' },
      remoteSessionSender: { sessionId: 'sender-1', title: '实现群邀请链接网页落地页' },
    });
    expect(item).not.toHaveProperty('origin');
  });

  it('reports queued when the target is busy', async () => {
    const { send } = setup({
      enqueue: async () => ({ ok: true, result: { pendingQueue: [{ clientId: 'client-1' }] } }),
    });
    await expect(send()).resolves.toMatchObject({ ok: true, wakeKind: 'queued' });
  });

  it('does not contact computers that are unknown, offline or not controllable', async () => {
    for (const [device, errorCode] of [
      [null, 'NOT_FOUND'],
      [{ platform: 'ios' }, 'NOT_FOUND'],
      [{ online: false }, 'REMOTE_DEVICE_OFFLINE'],
      [{ remoteControlEnabled: false }, 'REMOTE_DISABLED'],
    ] as const) {
      const { invoke, send } = setup({ device });
      await expect(send()).resolves.toMatchObject({ ok: false, errorCode });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it('refuses archived, deleted and missing tasks before enqueueing', async () => {
    for (const [get, errorCode] of [
      [async () => ({ ok: true, result: { ...row, status: 'archived' } }), 'ARCHIVED'],
      [async () => ({ ok: true, result: { ...row, status: 'deleted' } }), 'DELETED'],
      [
        async () => ({
          ok: false,
          error: {
            code: 'IPC_ERROR',
            message:
              "Error invoking remote method 'local-db:sessions:get': [NOT_FOUND] Session 不存在",
          },
        }),
        'NOT_FOUND',
      ],
    ] as const) {
      const { invoke, send } = setup({ get: get as () => Promise<InvokeResultPayload> });
      await expect(send()).resolves.toMatchObject({ ok: false, errorCode });
      expect(invoke.mock.calls.map((call) => call[1])).not.toContain('maker:input:enqueue');
    }
  });

  it('maps remote refusals and warns that a timeout may already be delivered', async () => {
    const review = setup({
      enqueue: async () => ({
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: '[UNSUPPORTED_CAPABILITY] Review tasks do not accept external input',
        },
      }),
    });
    await expect(review.send()).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_CAPABILITY',
    });

    const timeout = setup({
      enqueue: async () => {
        throw new DeviceLinkError('INVOKE_TIMEOUT', 'timed out');
      },
    });
    const result = await timeout.send();
    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_TIMEOUT' });
    expect(result.ok ? '' : result.message).toContain('get_chat_history');
  });

  it('drops the result when the account changes mid-delivery', async () => {
    const { deps, invoke } = setup();
    let current = true;
    deps.captureAccess = () => () => {
      if (!current) throw new Error('owner changed');
    };
    invoke.mockImplementationOnce(async () => {
      current = false;
      return { ok: true, result: row } as InvokeResultPayload;
    });
    await expect(
      sendToRemoteSession(deps, {
        target: { deviceId: 'studio', sessionId: 'task-1' },
        message: 'x',
        sender: { sessionId: 'sender-1' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
