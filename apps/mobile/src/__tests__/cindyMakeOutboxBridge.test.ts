import { describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { createOutboxSessionAccess } from '@/session/mobileOutboxSessionAdapter';

function harness(sessions: Array<{ id: string; source?: string; deviceLinkDeviceId: string }>) {
  const record = { deviceId: 'desktop', state: 'queued', uploads: [],
    item: { sessionId: 'session', clientId: 'client', attachmentSlots: [] } } as unknown as DurableOutboxRecord;
  const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[] | undefined, options: { preSend(): void }) => {
    options.preSend(); return { id: 'session', source: 'cc' };
  });
  const latest = { current: { link: { status: 'online', getPresenceAvailability: () => true, invoke } } };
  const owner = { current: true, records: [record] };
  const hasCreationTask = vi.fn(() => false);
  const callbacks = createOutboxSessionAccess({
    getSessions: () => sessions,
    getRecords: () => owner.records,
    guard: () => { if (!owner.current) throw new Error('OUTBOX_OWNER_CHANGED'); },
    isCurrent: () => owner.current,
    isForeground: () => true,
    canConnect: () => latest.current.link.status === 'online' && latest.current.link.getPresenceAvailability() !== false,
    isCreationHeld: () => false,
    hasCreationTask,
    needsReconciliation: () => true,
    invoke: (deviceId, channel, args, options) => latest.current.link.invoke(deviceId, channel, args, options),
    readSession: record => callbacks.invokeOwned(record)(record.deviceId, 'local-db:sessions:get', [record.item.sessionId]),
  });
  return { record, callbacks, invoke, latest, owner, hasCreationTask };
}

describe('Cindy Make outbox bridge guards', () => {
  // Unit: extracting the bridge must retain both ownership barriers around a
  // delayed RPC. Source-visibility tests alone do not cover removal/account changes.
  it('does not send a record removed while the transport was waiting', async () => {
    const { record, callbacks, invoke, owner } = harness([]);
    const sent = vi.fn();
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      owner.records = [];
      options.preSend();
      sent();
      return { id: 'session', source: 'cc' };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'maker:input:enqueue', ['session']))
      .rejects.toThrow('OUTBOX_STALE_WRITE');
    expect(sent).not.toHaveBeenCalled();
  });

  it('rejects a late reply after the account owner changes', async () => {
    const { record, callbacks, invoke, owner } = harness([]);
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      options.preSend();
      owner.current = false;
      return { id: 'session', source: 'cc' };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'local-db:sessions:get', ['session']))
      .rejects.toThrow('OUTBOX_OWNER_CHANGED');
  });

  it.each(['cindy-make', 'cindy-make-merge'])('selects a suspended hidden %s record for local cleanup even offline', async source => {
    const { record, callbacks, invoke, latest } = harness([{ id: 'session', source, deviceLinkDeviceId: 'desktop' }]);
    record.suspended = true;
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(true);
    expect(callbacks.canRun(record)).toBe(true);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not confuse the same session ID on another computer with a hidden task', async () => {
    const { record, callbacks, invoke } = harness([{ id: 'session', source: 'cindy-make', deviceLinkDeviceId: 'other-desktop' }]);
    expect(callbacks.hidden(record)).toBe(false);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    expect(invoke).toHaveBeenCalledWith('desktop', 'local-db:sessions:get', ['session'], expect.anything());
  });

  it.each(['cindy-make', 'cindy-make-merge'])('checks raw metadata again before enqueue when %s arrives late', async source => {
    const sessions = [{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }];
    const { record, callbacks, invoke } = harness(sessions);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    const sent = vi.fn();
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      sessions[0].source = source;
      options.preSend();
      sent();
      return { id: 'session', source };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'maker:input:enqueue', ['session'])).rejects.toThrow('OUTBOX_SESSION_DISABLED');
    expect(sent).not.toHaveBeenCalled();
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
  });

  it('keeps ordinary offline records suspended instead of deleting or delivering them', () => {
    const { record, callbacks, latest, hasCreationTask } = harness([{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }]);
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(false);
    expect(callbacks.canRun(record)).toBe(false);
    // Creation lookup can scan the ledger; offline records must short-circuit it.
    expect(hasCreationTask).not.toHaveBeenCalled();
    latest.current.link.status = 'online';
    record.suspended = true;
    expect(callbacks.canRun(record)).toBe(false);
  });
});
