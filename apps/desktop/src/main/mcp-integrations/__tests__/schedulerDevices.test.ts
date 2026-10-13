import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import { createSchedulerRemoteDeps } from '../schedulerDevices.js';

type Invoke = (
  deviceId: string,
  channel: string,
  args: unknown[],
  options?: { preSend?: () => void },
) => Promise<InvokeResultPayload>;

function setup(invoke = vi.fn<Invoke>(async () => ({ ok: true, result: [] }))) {
  let owner = 1;
  const captureAccess = () => {
    const captured = owner;
    return () => {
      if (captured !== owner) throw new Error('Owner changed');
    };
  };
  return {
    invoke,
    changeOwner: () => owner++,
    remote: createSchedulerRemoteDeps({ invoke, captureAccess, listDevices: async () => [] }),
  };
}

describe('desktop scheduler cross-device transport', () => {
  it('reuses the existing remote-control schedule channels with their argument shapes', async () => {
    const s = setup();
    await s.remote.invoke('mac', 'list', [{ status: 'active' }]);
    await s.remote.invoke('mac', 'list-runs', ['s1', 5]);
    for (const op of ['get', 'pause', 'resume', 'delete', 'run-now'] as const) {
      s.invoke.mockResolvedValueOnce({
        ok: true,
        result: op === 'delete' ? undefined : { id: 's1' },
      });
      expect(await s.remote.invoke('mac', op, ['s1'])).toEqual({
        ok: true,
        data: op === 'delete' ? null : { id: 's1' },
      });
    }
    s.invoke.mockResolvedValueOnce({ ok: true, result: { id: 's1' } });
    await s.remote.invoke('mac', 'update', ['s1', { name: 'n' }]);
    expect(s.invoke.mock.calls.map(([device, channel, args]) => [device, channel, args])).toEqual([
      ['mac', 'maker:schedule:list', [{ status: 'active' }]],
      ['mac', 'maker:schedule:list-runs', ['s1', 5]],
      ['mac', 'maker:schedule:get', ['s1']],
      ['mac', 'maker:schedule:pause', ['s1']],
      ['mac', 'maker:schedule:resume', ['s1']],
      ['mac', 'maker:schedule:delete', ['s1']],
      ['mac', 'maker:schedule:run-now', ['s1']],
      ['mac', 'maker:schedule:update', ['s1', { name: 'n' }]],
    ]);
  });

  it('reports an older peer, offline, disabled, timeout and remote business errors explicitly', async () => {
    const cases: Array<[InvokeResultPayload | Error, string]> = [
      [{ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'no' } }, 'REMOTE_UNSUPPORTED'],
      [
        {
          ok: false,
          error: {
            code: 'IPC_ERROR',
            message: 'Error invoking remote method: Error: [NOT_FOUND] Schedule not found: s1',
          },
        },
        'NOT_FOUND',
      ],
      [
        { ok: false, error: { code: 'IPC_ERROR', message: '[INVALID_PARAMS] invalid cron' } },
        'INVALID_PARAMS',
      ],
      [new DeviceLinkError('DEVICE_OFFLINE', 'offline'), 'REMOTE_DEVICE_OFFLINE'],
      [new DeviceLinkError('REMOTE_DISABLED', 'off'), 'REMOTE_DISABLED'],
      [new DeviceLinkError('INVOKE_TIMEOUT', 'slow'), 'REMOTE_TIMEOUT'],
      [
        new Error('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally'),
        'REMOTE_DISABLED',
      ],
      [new Error('[DEVICE_LINK_STANDBY] owned elsewhere'), 'DEVICE_LINK_NOT_READY'],
      [new Error('boom'), 'REMOTE_UNAVAILABLE'],
    ];
    for (const [outcome, code] of cases) {
      const s = setup(
        vi.fn<Invoke>(async () => {
          if (outcome instanceof Error) throw outcome;
          return outcome as InvokeResultPayload;
        }),
      );
      expect(await s.remote.invoke('mac', 'pause', ['s1'])).toMatchObject({ ok: false, code });
    }
  });

  it('treats a lost reply as possibly applied rather than not sent', async () => {
    const lost = Object.assign(new DeviceLinkError('NOT_CONNECTED', 'dropped'), { inFlight: true });
    const s = setup(
      vi.fn<Invoke>(async () => {
        throw lost;
      }),
    );
    const result = await s.remote.invoke('mac', 'delete', ['s1']);
    expect(result).toMatchObject({ ok: false, code: 'REMOTE_TIMEOUT' });
    expect(result.ok === false && result.message).toContain('可能已生效');
  });

  it('rejects a malformed list and never sends after the account changes', async () => {
    const malformed = setup(vi.fn<Invoke>(async () => ({ ok: true, result: { not: 'a list' } })));
    expect(await malformed.remote.invoke('mac', 'list', [undefined])).toMatchObject({
      ok: false,
      code: 'REMOTE_INVALID_RESPONSE',
    });
    const s = setup(
      vi.fn<Invoke>(async (_d, _c, _a, options) => {
        s.changeOwner();
        options?.preSend?.();
        return { ok: true, result: [] };
      }),
    );
    expect(await s.remote.invoke('mac', 'list', [undefined])).toMatchObject({ ok: false });
  });
});
