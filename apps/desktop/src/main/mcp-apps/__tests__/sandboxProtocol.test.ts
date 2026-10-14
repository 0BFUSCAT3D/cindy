import { afterEach, describe, expect, it, vi } from 'vitest';
import { protocol } from 'electron';
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
  unmountRemoteAppDocument,
} from '../sandboxProtocol.js';
afterEach(() => {
  clearMcpAppDocuments();
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
