import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, protocol, session, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
vi.mock('electron', async (original) => {
  const electron = await original<typeof import('electron')>();
  return { ...electron, session: { ...electron.session, defaultSession: {
    ...electron.session.defaultSession, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
  } } };
});
const state = vi.hoisted(() => ({ owner: {} as object | null }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.owner,
}));
import {
  assertMcpAppDocumentCaller,
  clearMcpAppDocuments,
  mountRemoteAppDocument,
  registerMcpAppProtocol,
  isMcpAppFrameNavigationAllowed,
  isMcpAppPermissionRequest,
  unmountRemoteAppDocument,
} from '../sandboxProtocol.js';
afterEach(() => {
  clearMcpAppDocuments();
  app.removeAllListeners('web-contents-created');
  vi.restoreAllMocks();
  state.owner = {};
});
const document = {
  viewId: 'untrusted-id',
  html: '<!doctype html><body>App',
  csp: 'default-src *',
  prefersBorder: true,
};
describe('MCP App local protocol isolation', () => {
  it('installs both permission handlers and denies App and opaque subframe requests', () => {
    registerMcpAppProtocol();
    const request = vi.mocked(session.defaultSession.setPermissionRequestHandler).mock.calls.at(-1)![0]!;
    const check = vi.mocked(session.defaultSession.setPermissionCheckHandler).mock.calls.at(-1)![0]!;
    const callback = vi.fn();
    const details = { isMainFrame: false, requestingUrl: 'cindy-mcp-app://view-view/resource' };
    request(null as unknown as WebContents, 'notifications', callback, details);
    expect(callback).toHaveBeenCalledWith(false);
    expect(check(null, 'midi', 'cindy-mcp-app://view-view', details)).toBe(false);
    expect(check(null, 'serial', 'null', { isMainFrame: false })).toBe(false);
    expect(check(null, 'media', 'file://', { isMainFrame: true, requestingUrl: 'file:///host.html' })).toBe(true);
  });
  it('denies permissions for external descendants by their real ancestry', () => {
    const resource = { url: 'cindy-mcp-app://view-view/resource', parent: null };
    const nested = { url: 'https://embed.example.org', parent: resource };
    const unrelated = { url: 'https://other.example.org', parent: null };
    const contents = { mainFrame: { framesInSubtree: [resource, nested, unrelated] } } as unknown as WebContents;
    expect(isMcpAppPermissionRequest(contents, { isMainFrame: false, requestingUrl: nested.url })).toBe(true);
    expect(isMcpAppPermissionRequest(contents, { isMainFrame: false })).toBe(true);
    expect(isMcpAppPermissionRequest(contents, { isMainFrame: false, requestingUrl: unrelated.url })).toBe(false);
  });
  it('forwards unmodified Escape from the focused App into its trusted sandbox only', () => {
    registerMcpAppProtocol();
    const id = mountRemoteAppDocument(document, 'renderer:1');
    const sandbox = { url: `cindy-mcp-app://${id}/sandbox`, parent: null, executeJavaScript: vi.fn(async () => {}) };
    const contents = Object.assign(new EventEmitter(), { focusedFrame: { url: `cindy-mcp-app://${id}-view/resource`, parent: sandbox } });
    app.emit('web-contents-created', {}, contents);
    const event = { preventDefault: vi.fn() };
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', isComposing: true });
    expect(sandbox.executeJavaScript).not.toHaveBeenCalled();
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
    expect(sandbox.executeJavaScript).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    state.owner = {};
    contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
    expect(sandbox.executeJavaScript).toHaveBeenCalledOnce();
  });
  it('rebuilds remote CSP and serves only the current owner through distinct origins', async () => {
    let handler!: (request: Request) => Promise<Response> | Response;
    vi.spyOn(protocol, 'handle').mockImplementation((_scheme, callback) => {
      handler = callback;
    });
    registerMcpAppProtocol();
    const id = mountRemoteAppDocument(document, 'renderer:1');
    const resource = await handler(new Request('cindy-mcp-app://' + id + '-view/resource'));
    expect(resource.status).toBe(200);
    expect(resource.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    expect(await resource.text()).toBe(document.html);
    const sandbox = await handler(new Request('cindy-mcp-app://' + id + '/sandbox'));
    expect(sandbox.headers.get('Content-Security-Policy')).toContain(
      'frame-src cindy-mcp-app://' + id + '-view',
    );
    for (const path of [
      'cindy-mcp-app://' + id + '/resource',
      'cindy-mcp-app://' + id + '-view/sandbox',
      'cindy-mcp-app://' + id + '/secret',
    ])
      expect((await handler(new Request(path))).status).toBe(404);
    state.owner = {};
    expect((await handler(new Request('cindy-mcp-app://' + id + '-view/resource'))).status).toBe(
      404,
    );
  });
  it('binds local mounts and privileged links to the mounting renderer and owner', () => {
    const id = mountRemoteAppDocument(document, 'renderer:1');
    expect(() => assertMcpAppDocumentCaller(id, 'renderer:1')).not.toThrow();
    expect(() => unmountRemoteAppDocument(id, 'renderer:2')).toThrow('MCP_APP_VIEW_UNAVAILABLE');
    state.owner = {};
    expect(() => assertMcpAppDocumentCaller(id, 'renderer:1')).toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('does not allow a policy-bearing App to navigate itself into a privileged or external page', () => {
    const source = 'cindy-mcp-app://example-view/resource';
    expect(isMcpAppFrameNavigationAllowed(source, source + '#section')).toBe(true);
    expect(isMcpAppFrameNavigationAllowed('cindy-mcp-app://example/sandbox', source)).toBe(true);
    for (const target of [
      'https://example.org',
      'file:///private',
      'cindy-mcp-app://other-view/resource',
      'cindy-mcp-app://example/sandbox',
    ])
      expect(isMcpAppFrameNavigationAllowed(source, target)).toBe(false);
    expect(
      isMcpAppFrameNavigationAllowed('https://existing-cindy-view', 'https://existing-link'),
    ).toBe(true);
  });
  it('allows nested navigation only to the owning App approved frame domains', () => {
    const source = 'cindy-mcp-app://example-view/resource';
    const domains = ['https://frames.example.org', 'https://*.embed.example.org:*'];
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org/view', domains)).toBe(
      true,
    );
    expect(
      isMcpAppFrameNavigationAllowed(
        'https://frames.example.org',
        'https://sub.embed.example.org:8443/view',
        domains,
      ),
    ).toBe(true);
    for (const target of [
      'https://other.example.org',
      'http://frames.example.org',
      'file:///private',
      'cindy-mcp-app://other-view/resource',
    ])
      expect(isMcpAppFrameNavigationAllowed(source, target, domains)).toBe(false);
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org', [])).toBe(false);
    // Declaring a domain does not allow the App document itself to leave its origin.
    expect(isMcpAppFrameNavigationAllowed(source, 'https://frames.example.org')).toBe(false);
  });
});
