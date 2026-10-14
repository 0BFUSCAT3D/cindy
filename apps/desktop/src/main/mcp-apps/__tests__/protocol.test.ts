import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  appCsp,
  readAppResource,
  safeAppLink,
  toolVisibleTo,
  uiToolUri,
  MCP_APPS_MAX_BYTES,
} from '../protocol.js';

const tool = (ui: unknown): Tool => ({
  name: 'example',
  inputSchema: { type: 'object' },
  _meta: { ui },
});
const uri = 'ui://example/app.html';
describe('standard MCP Apps metadata and policy', () => {
  it('defaults tools to both audiences and enforces explicit visibility', () => {
    expect(toolVisibleTo(tool({}), 'app')).toBe(true);
    expect(toolVisibleTo(tool({}), 'model')).toBe(true);
    expect(toolVisibleTo(tool({ visibility: ['app'] }), 'model')).toBe(false);
    expect(toolVisibleTo(tool({ visibility: ['model'] }), 'app')).toBe(false);
    expect(toolVisibleTo(tool({ visibility: 'app' }), 'app')).toBe(false);
    expect(uiToolUri(tool({ resourceUri: uri }))).toBe(uri);
    expect(uiToolUri({ ...tool({}), _meta: { 'ui/resourceUri': uri } })).toBe(uri);
    expect(uiToolUri(tool({ resourceUri: 'https://example.org/app' }))).toBeUndefined();
  });
  it('reads text or base64 HTML and honors read metadata before list metadata', () => {
    const html = '<!doctype html><html><body>标准应用</body></html>';
    for (const data of [{ text: html }, { blob: Buffer.from(html).toString('base64') }]) {
      expect(
        readAppResource(
          { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', ...data }] },
          uri,
          { prefersBorder: false },
        ),
      ).toEqual({ html, meta: { prefersBorder: false } });
    }
    expect(
      readAppResource(
        {
          contents: [
            {
              uri,
              mimeType: 'text/html;profile=mcp-app',
              text: html,
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        },
        uri,
        { prefersBorder: false },
      ).meta.prefersBorder,
    ).toBe(true);
  });
  it('rejects wrong URI, MIME, invalid base64 and oversized resource bytes', () => {
    expect(() =>
      readAppResource({ contents: [{ uri, text: '', mimeType: 'text/html' }] }, uri),
    ).toThrow('MCP_APP_RESOURCE_MISSING');
    expect(() =>
      readAppResource(
        { contents: [{ uri: 'ui://other', text: '', mimeType: 'text/html;profile=mcp-app' }] },
        uri,
      ),
    ).toThrow('MCP_APP_RESOURCE_MISSING');
    expect(() =>
      readAppResource(
        { contents: [{ uri, blob: '!!invalid!!', mimeType: 'text/html;profile=mcp-app' }] },
        uri,
      ),
    ).toThrow('MCP_APP_INVALID_RESOURCE');
    expect(() =>
      readAppResource(
        {
          contents: [
            {
              uri,
              text: '汉'.repeat(MCP_APPS_MAX_BYTES / 3 + 1),
              mimeType: 'text/html;profile=mcp-app',
            },
          ],
        },
        uri,
      ),
    ).toThrow('MCP_APP_RESOURCE_TOO_LARGE');
  });
  it('restricts omitted domains and keeps each declared domain in its directive', () => {
    expect(appCsp().header).toContain("connect-src 'none'; frame-src 'none'; base-uri 'none'");
    const policy = appCsp({
      csp: {
        connectDomains: ['https://api.example.org', 'wss://*.example.org:443'],
        resourceDomains: ['https://cdn.example.org'],
        frameDomains: ['https://frame.example.org'],
        baseUriDomains: ['https://base.example.org'],
      },
    });
    expect(policy.header).toContain('connect-src https://api.example.org wss://*.example.org:443');
    expect(policy.header).toContain('frame-src https://frame.example.org');
    expect(policy.header).toContain('base-uri https://base.example.org');
    expect(policy.header).not.toContain("'unsafe-eval'");
  });
  it.each([
    'https://example.org; script-src *',
    '*',
    'file://local',
    'data:',
    'https://user:password@example.org',
    'https://example.org/path',
    "https://example.org 'unsafe-eval'",
    'https://example.org:99999',
  ])('rejects CSP source injection: %s', (source) => {
    expect(() => appCsp({ csp: { connectDomains: [source] } })).toThrow();
  });
  it.each([
    'file:///C:/secret',
    'javascript:alert(1)',
    'data:text/html,x',
    'https://user:secret@example.org',
    'not a URL',
  ])('rejects privileged or malformed links: %s', (url) => {
    expect(() => safeAppLink(url)).toThrow('MCP_APP_INVALID_LINK');
  });
});
