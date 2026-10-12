import { expect, it, vi } from 'vitest';
import { registerPluginUsageIpc } from '../ipc';
import type { PluginUsageService } from '../service';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
function harness(trusted = true) {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const service = {
    summary: vi.fn(async () => null),
    history: vi.fn(async () => []),
    clear: vi.fn(async () => {}),
    bind: vi.fn(),
    capture: vi.fn(),
  } as unknown as PluginUsageService;
  const warn = vi.fn();
  registerPluginUsageIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) } as Pick<IpcMain, 'handle'>,
    assertTrusted: () => {
      if (!trusted) throw new Error('Untrusted frame');
    },
    service: () => service,
    identity: () => null,
    warn,
  });
  return { handlers, service, warn };
}
it('checks trusted top-level app sender on every usage endpoint before reading or clearing', async () => {
  const { handlers, service } = harness(false);
  for (const handler of handlers.values())
    await expect(handler({} as IpcMainInvokeEvent, null)).rejects.toThrow('Untrusted frame');
  expect(service.summary).not.toHaveBeenCalled();
  expect(service.clear).not.toHaveBeenCalled();
  expect(service.history).not.toHaveBeenCalled();
});
it('never treats a missing or malformed subject as clear-all; only explicit null clears all', async () => {
  const { handlers, service } = harness();
  const clear = handlers.get('ghosts:usage-clear')!;
  for (const id of [undefined, {}, 42, 'a'.repeat(36)])
    await expect(clear({} as IpcMainInvokeEvent, id)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  expect(service.clear).not.toHaveBeenCalled();
  await clear({} as IpcMainInvokeEvent, null);
  expect(service.clear).toHaveBeenCalledWith(null);
  const id = '12345678-1234-1234-1234-123456789012';
  await clear({} as IpcMainInvokeEvent, id);
  expect(service.clear).toHaveBeenLastCalledWith(id);
});
it('hides database failures and preserves deliberate visibility and argument errors', async () => {
  const { handlers, service, warn } = harness();
  vi.mocked(service.history).mockRejectedValue(new Error('SQL secret path'));
  await expect(
    handlers.get('ghosts:usage-history')!({} as IpcMainInvokeEvent),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.not.stringContaining('secret'),
  });
  expect(warn).toHaveBeenCalledOnce();
  await expect(
    handlers.get('ghosts:usage-summary')!({} as IpcMainInvokeEvent, 'valid-plugin'),
  ).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
