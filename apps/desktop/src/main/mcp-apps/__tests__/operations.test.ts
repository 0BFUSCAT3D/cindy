import { describe, expect, it, vi } from 'vitest';
import { handleMcpAppOperation } from '../operations.js';
import type { McpAppsHost } from '../host.js';
function fixture() {
  const document = { viewId: 'view', html: '<!doctype html>', csp: '', prefersBorder: true };
  const api = {
    open: vi.fn(async () => document),
    dispatch: vi.fn(),
    poll: vi.fn(async () => []),
    context: vi.fn(),
    teardown: vi.fn(),
    displayMode: vi.fn(),
    linkResult: vi.fn(),
  };
  const host = api as unknown as McpAppsHost;
  const local = {
    supply: vi.fn(),
    mount: vi.fn(() => 'mounted'),
    unmount: vi.fn(),
    assertCaller: vi.fn(),
    openLink: vi.fn(async () => {}),
  };
  return { host, api, local, document };
}
describe('task-bound MCP App operations', () => {
  it('binds every operation to the verified caller and exact task', async () => {
    const f = fixture();
    expect(
      await handleMcpAppOperation(
        f.host,
        'renderer:1',
        'task',
        { op: 'open', clientId: 'card', context: { theme: 'dark' } },
        f.local,
      ),
    ).toBe(f.document);
    expect(f.api.open).toHaveBeenCalledWith('renderer:1', 'task', 'card', { theme: 'dark' });
    expect(f.local.supply).toHaveBeenCalledWith(f.document, 'renderer:1');
    await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'poll',
      viewId: 'view',
      after: 4,
    });
    expect(f.api.poll).toHaveBeenCalledWith('device:phone', 'task', 'view', 4);
    await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'link-result',
      viewId: 'view',
      linkId: 'link',
      success: false,
    });
    expect(f.api.linkResult).toHaveBeenCalledWith('device:phone', 'task', 'view', 'link', false);
  });
  it.each([
    { op: 'poll', viewId: 'view', after: -1 },
    { op: 'poll', viewId: 'view', after: 1.5 },
    { op: 'open', clientId: '' },
    { op: 'open', clientId: 'card', context: { theme: 'other' } },
    { op: 'teardown', viewId: 'view', alreadyNotified: 'true' },
    { op: 'context', viewId: 'view', context: { deviceCapabilities: { touch: 'yes' } } },
    { op: 'display-mode', viewId: 'view', mode: 'window' },
    { op: 'arbitrary-shell', command: 'echo' },
  ])('rejects malformed operations before reaching the Host: %j', async (raw) => {
    const f = fixture();
    await expect(handleMcpAppOperation(f.host, 'renderer:1', 'task', raw, f.local)).rejects.toThrow(
      'MCP_APP_INVALID_REQUEST',
    );
    Object.values(f.api).forEach((call) => expect(call).not.toHaveBeenCalled());
  });
  it('forbids remote requests from mounting HTML or opening links on the execution computer', async () => {
    const f = fixture();
    for (const raw of [
      { op: 'mount-remote', document: f.document },
      { op: 'unmount-remote', viewId: 'view' },
      { op: 'open-link', viewId: 'view', url: 'https://example.org' },
    ])
      await expect(handleMcpAppOperation(f.host, 'device:phone', 'task', raw)).rejects.toThrow(
        'MCP_APP_INVALID_REQUEST',
      );
  });
  it('verifies the local document owner before opening a safe URL', async () => {
    const f = fixture();
    await handleMcpAppOperation(
      f.host,
      'renderer:1',
      'task',
      { op: 'open-link', viewId: 'view', url: 'https://example.org' },
      f.local,
    );
    expect(f.local.assertCaller).toHaveBeenCalledWith('view', 'renderer:1');
    expect(f.local.openLink).toHaveBeenCalledWith('https://example.org/');
    await expect(
      handleMcpAppOperation(
        f.host,
        'renderer:1',
        'task',
        { op: 'open-link', viewId: 'view', url: 'file:///private' },
        f.local,
      ),
    ).rejects.toThrow('MCP_APP_INVALID_LINK');
    expect(f.local.openLink).toHaveBeenCalledOnce();
  });
});
