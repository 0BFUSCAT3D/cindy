import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { mcpAppSandboxDocument, mcpAppFrameUrlAllowed, mcpAppHistoryText, parseMcpAppRecord, parseMcpAppHistory } from '../mcpApps.js';
describe('MCP Apps cross-platform document contract', () => {
  function proxy(resourceUrl: string, requestedUrl = resourceUrl) {
    const frame = { setAttribute() {}, style: {}, src: '', srcdoc: '' };
    let receive!: (event: unknown) => void;
    let mounted = false;
    const window = {
      location: { href: 'http://127.0.0.1:5002/proxy.html' },
      parent: { postMessage() {} },
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'message') receive = listener;
      },
    };
    const document = { createElement: () => frame, body: { appendChild: () => { mounted = true; } } };
    const html = mcpAppSandboxDocument('', resourceUrl);
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    new Script(script).runInNewContext({ window, document, URL });
    receive({ source: window.parent, data: { jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { resourceUrl: requestedUrl, html: '<script>untrusted</script>' } } });
    return { frame, mounted };
  }
  it('pins the proxy resource URL to its Host-generated cross-origin document', () => {
    const result = proxy('http://127.0.0.1:5001/resource.html', 'http://127.0.0.1:5002/attack.html');
    expect(result.mounted).toBe(true);
    expect(result.frame.src).toBe('http://127.0.0.1:5001/resource.html');
    expect(result.frame.srcdoc).toBe('');
  });
  it.each(['http://127.0.0.1:5002/app.html', 'javascript:alert(1)', 'file:///private'])
    ('refuses a same-origin or privileged resource URL: %s', (url) => {
      expect(proxy(url).mounted).toBe(false);
    });
  it('escapes native bridge keys without changing their JavaScript value', () => {
    const key = '</script><script>attack</script>';
    const html = mcpAppSandboxDocument(key);
    expect(html).not.toContain(key);
    expect(html.match(/<script>/gi)).toHaveLength(1);
    const encoded = html.match(/const bridgeKey=(.*?);/s)![1];
    expect(JSON.parse(encoded)).toBe(key);
  });
  it('denies undeclared native navigation and matches exact or wildcard domains', () => {
    expect(mcpAppFrameUrlAllowed('https://example.org')).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://a.example.org', ['https://*.example.org'])).toBe(true);
    expect(mcpAppFrameUrlAllowed('https://example.org', ['https://*.example.org'])).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://badexample.org', ['https://*.example.org'])).toBe(false);
    expect(mcpAppFrameUrlAllowed('https://a.example.org:9443', ['https://*.example.org:*'])).toBe(
      true,
    );
    expect(mcpAppFrameUrlAllowed('file:///private', ['https://example.org'])).toBe(false);
  });
  it('rejects malformed persisted cards while accepting additive fields', () => {
    const record = {
      version: 1,
      serverId: 'example',
      serverRevision: 'revision',
      resourceUri: 'ui://example/app',
      tool: { name: 'draft', inputSchema: { type: 'object' } },
      arguments: {},
      future: true,
    };
    expect(parseMcpAppRecord({ mcpApp: record })).toBe(record);
    expect(parseMcpAppRecord({ mcpApp: { ...record, arguments: [] } })).toBeUndefined();
    expect(
      parseMcpAppRecord({ mcpApp: { ...record, result: { content: 'invalid' } } }),
    ).toBeUndefined();
  });
  it('projects only saved public text blocks for read-only history', () => {
    const record = parseMcpAppRecord({ mcpApp: {
      version: 1, serverId: 'example', serverRevision: 'revision', resourceUri: 'ui://example/app',
      tool: { name: 'draft', inputSchema: { type: 'object' } }, arguments: { private: 'input' },
    } })!;
    expect(mcpAppHistoryText(record)).toBe('');
    record.result = {
      content: [
        { type: 'text', text: 'Saved result' },
        { type: 'image', data: 'private image' },
        { type: 'resource', resource: { text: 'embedded HTML' } },
        null, 'invalid', { type: 'text', text: 123 },
        { type: 'text', text: '<script>plain text</script>' },
      ],
      structuredContent: { private: 'structured' },
      _meta: { private: 'view-only' },
    };
    expect(mcpAppHistoryText(record)).toBe('Saved result\n\n<script>plain text</script>');
  });
  it('accepts public guest history for display without granting access to an App View', () => {
    const content = {
      mcpAppHistory: { version: 1, title: 'Draft form', text: 'Saved result' },
    };
    expect(parseMcpAppHistory(content)).toEqual({
      title: 'Draft form',
      text: 'Saved result',
    });
    expect(parseMcpAppRecord(content)).toBeUndefined();
    expect(
      parseMcpAppHistory({
        mcpAppHistory: { version: 1, title: 'Draft form', text: '' },
      }),
    ).toEqual({ title: 'Draft form', text: '' });
  });
  it.each([
    null,
    [],
    { version: 2, title: 'Draft', text: 'result' },
    { version: 1, title: {}, text: 'result' },
    { version: 1, title: 'Draft', text: {} },
  ])('rejects malformed public history %j', (mcpAppHistory) => {
    expect(parseMcpAppHistory({ mcpAppHistory })).toBeUndefined();
  });
});
