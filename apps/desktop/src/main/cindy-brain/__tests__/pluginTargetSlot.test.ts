import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginTargetPickerPush } from '../../../shared/pluginTargets.js';

const state = vi.hoisted(() => ({ bindings: {} as Record<string, unknown> }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  ownerScopedUserDataPath: () => '/not-written.json',
  getActiveDataOwnerPushStamp: () => ({ ownerGeneration: 1 }),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({}) },
}));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: () => {},
    read: () => state,
    updateAtomic: async (update: (input: { value: typeof state }) => Partial<typeof state>) =>
      Object.assign(state, update({ value: state })),
  }),
}));
import { PluginTargetSlot, type PluginTargetAdapter } from '../pluginTargetSlot.js';

describe('user-selected plugin destinations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.bindings = {};
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function fixture() {
    let push: PluginTargetPickerPush | null = null;
    const slot = new PluginTargetSlot({
      name: () => 'Example plugin',
      revision: () => 'approved-install',
      open: (value) => {
        push = value;
        return { senderId: 7, close: vi.fn() };
      },
    });
    const send = vi.fn<PluginTargetAdapter['send']>(async () => 'queue');
    const create = vi.fn(async () => {});
    const withdraw = vi.fn(async () => {});
    slot.adapter = {
      candidates: async () => [{ id: 'chosen', label: 'Chosen task', detail: '' }],
      session: async () => 'chosen',
      send,
      create,
      withdraw,
    };
    const guard = vi.fn();
    const call = (payload: unknown, plugin = 'plugin') => slot.handle(plugin, payload, guard);
    const pick = async (persistent = false, targetKind = 'task') => {
      const result = call({ kind: 'pick', requestKey: 'select', targetKind, persistent });
      await vi.advanceTimersByTimeAsync(0);
      const request = push!;
      expect(slot.resolve(request.requestId, 99, 'chosen')).toBe(false);
      expect(slot.resolve(request.requestId, 7, 'chosen')).toBe(true);
      return (await result) as { bindingId: string };
    };
    return { slot, call, pick, send, create, withdraw, getPush: () => push };
  }
  // Production entry: PluginTargetSlot.handle. Protects targets.send's delivery/default
  // and idempotency contract; existing ownership cases do not cover this field. In-memory unit tier.
  it('carries screenshot bytes once and rejects a changed attachment on the same receipt', async () => {
    const f = fixture(), picked = await f.pick();
    const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const request = { kind: 'send', bindingId: picked.bindingId, requestKey: 'image', text: 'context',
      attachments: [{ base64, name: 'window.png' }] };
    await f.call(request);
    await f.call(structuredClone(request));
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[7]?.[0]).toMatchObject({ mimeType: 'image/png', name: 'window.png' });
    await expect(f.call({ ...request, attachments: [{ base64, name: 'other.png' }] }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  });
  it('rejects a forged media URL before creating or sending a target task', async () => {
    const f = fixture(), picked = await f.pick(false, 'project');
    await expect(f.call({ kind: 'send', bindingId: picked.bindingId, requestKey: 'image', text: 'context',
      attachments: [{ url: 'cindy-media://blobs/foreign.png' }] })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENTS' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([undefined, 'queue', 'steer'] as const)('preserves requested delivery %s and reports actual delivery', async (delivery) => {
    const f = fixture(), picked = await f.pick();
    const request = { kind: 'send', bindingId: picked.bindingId, requestKey: 'send', text: 'context', delivery };
    expect(await f.call(request)).toMatchObject({ accepted: true, delivery: 'queue' });
    expect(f.send.mock.calls[0]?.[6]).toBe(delivery ?? 'queue');
    // A mode change cannot reuse an accepted request to inject the same content twice.
    await expect(f.call({ ...request, delivery: delivery === 'steer' ? 'queue' : 'steer' }))
      .rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it('reports successful steering and treats omitted delivery as an explicit queue retry', async () => {
    const f = fixture(), picked = await f.pick();
    f.send.mockResolvedValueOnce('steer');
    expect(await f.call({ kind: 'send', bindingId: picked.bindingId, requestKey: 'steer', text: 'context', delivery: 'steer' }))
      .toMatchObject({ accepted: true, delivery: 'steer' });
    const other = await f.pick();
    const request = { kind: 'send', bindingId: other.bindingId, requestKey: 'queue', text: 'context' };
    await f.call(request);
    expect(await f.call({ ...request, delivery: 'queue' })).toMatchObject({ delivery: 'queue' });
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(['invalid', 'project-steer'])('rejects %s before any target mutation', async (mode) => {
    const f = fixture(), picked = await f.pick(false, mode === 'project-steer' ? 'project' : 'task');
    await expect(f.call({ kind: 'send', bindingId: picked.bindingId, requestKey: 'send', text: 'context',
      delivery: mode === 'project-steer' ? 'steer' : 'interrupt' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects a plugin-supplied task ID and does not expose a candidate list to the plugin', async () => {
    const f = fixture();
    await expect(
      f.call({ kind: 'send', bindingId: 'chosen', requestKey: 'a', text: 'context' }),
    ).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    const picked = await f.pick();
    expect(picked).not.toHaveProperty('candidates');
    expect(picked).not.toHaveProperty('targetId');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('cannot turn a one-time selection into a persistent binding or use it from another plugin', async () => {
    const f = fixture(),
      picked = await f.pick();
    await expect(f.call({ kind: 'get', bindingId: picked.bindingId })).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
    await expect(
      f.call(
        { kind: 'send', bindingId: picked.bindingId, requestKey: 'a', text: 'context' },
        'another',
      ),
    ).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  });
  it('requires fixed bindings to be resolved and rejects replay with a new key or changed text', async () => {
    const f = fixture(),
      saved = await f.pick(true);
    await expect(
      f.call({ kind: 'send', bindingId: saved.bindingId, requestKey: 'a', text: 'context' }),
    ).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    const handle = (await f.call({ kind: 'get', bindingId: saved.bindingId })) as {
      bindingId: string;
    };
    const request = { kind: 'send', bindingId: handle.bindingId, requestKey: 'a', text: 'context' };
    await Promise.all([f.call(request), f.call(request)]);
    expect(f.send).toHaveBeenCalledTimes(1);
    await expect(f.call({ ...request, requestKey: 'b', text: 'changed' })).rejects.toMatchObject({
      code: 'DELIVERY_UNCERTAIN',
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('cancels a picker and rejects its late selection without delivering anything', async () => {
    const f = fixture();
    const selection = f.call({ kind: 'pick', requestKey: 'old', targetKind: 'task' });
    const settled = expect(selection).rejects.toMatchObject({ code: 'SUPERSEDED' });
    await vi.advanceTimersByTimeAsync(0);
    const requestId = f.getPush()!.requestId;
    await f.call({ kind: 'cancel', requestKey: 'old' });
    expect(f.slot.resolve(requestId, 7, 'chosen')).toBe(false);
    await settled;
    expect(f.send).not.toHaveBeenCalled();
  });
  it('fails closed when a fixed target disappears and does not choose a substitute', async () => {
    const f = fixture(),
      saved = await f.pick(true);
    f.slot.adapter!.candidates = async () => [
      { id: 'different', label: 'Another task', detail: '' },
    ];
    await expect(f.call({ kind: 'get', bindingId: saved.bindingId })).rejects.toMatchObject({
      code: 'TARGET_UNAVAILABLE',
    });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not reopen an older picker after a slow candidate query finishes', async () => {
    const f = fixture();
    let releaseOld!: (value: Array<{ id: string; label: string; detail: string }>) => void;
    f.slot.adapter!.candidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOld = resolve;
          }),
      )
      .mockResolvedValue([{ id: 'chosen', label: 'Chosen task', detail: '' }]);
    const old = f.call({ kind: 'pick', requestKey: 'slow', targetKind: 'task' });
    const rejected = expect(old).rejects.toMatchObject({ code: 'SUPERSEDED' });
    const current = f.call({ kind: 'pick', requestKey: 'current', targetKind: 'task' });
    await vi.advanceTimersByTimeAsync(0);
    const requestId = f.getPush()!.requestId;
    releaseOld([{ id: 'chosen', label: 'Chosen task', detail: '' }]);
    await rejected;
    expect(f.getPush()!.requestId).toBe(requestId);
    f.slot.resolve(requestId, 7, 'chosen');
    await current;
    expect(f.send).not.toHaveBeenCalled();
  });
});
