import { describe, expect, it } from 'vitest';
import { mcpAppSandboxDocument, mcpAppFrameUrlAllowed, parseMcpAppRecord } from '../mcpApps.js';
describe('MCP Apps cross-platform document contract', () => {
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
});
