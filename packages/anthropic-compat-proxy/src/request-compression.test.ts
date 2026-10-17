import { createServer, request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressGzip } from './compression.js';
import { createAnthropicCompatProxy } from './server.js';
import { shouldCompressRequest } from './request-compression.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import type { ProxyHandle, ProxyOptions } from './types.js';

// Value: the production proxy must gzip only its final supported HTTP upload,
// preserving recovery, cancellation and dispatch authorization. Existing tests
// only use plain loopback targets, which deliberately never enable compression.
// Minimal input: >=64 KiB JSON routed to the first-party Messages endpoint.
// Tier: unit, one loopback fixture; HTTPS is redirected here, never to the internet.
const transport = vi.hoisted(() => ({ port: 0 }));
vi.mock('node:https', async (original) => ({
  ...await original<typeof import('node:https')>(),
  request: (options: RequestOptions) => httpRequest({
    ...options, hostname: '127.0.0.1', port: transport.port, agent: undefined,
  }),
}));
vi.mock('./compression.js', async (original) => {
  const actual = await original<typeof import('./compression.js')>();
  return { ...actual, compressGzip: vi.fn(actual.compressGzip) };
});

const records: Array<{ body: Buffer; headers: IncomingHttpHeaders }> = [];
let responses: number[] = [];
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    records.push({ body: Buffer.concat(chunks), headers: req.headers });
    res.writeHead(responses.shift() ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'remove forbidden' }));
  });
});
let proxy: ProxyHandle | undefined;
beforeAll(async () => { transport.port = await listenOnAvailableLoopbackPort(upstream); });
beforeEach(() => { records.length = 0; responses = []; vi.mocked(compressGzip).mockClear(); });
afterEach(async () => { await proxy?.dispose(); proxy = undefined; });
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const large = { model: 'claude-test', messages: [{ role: 'user', content: '中文代码🙂'.repeat(12_000) }] };
async function start(options: Partial<ProxyOptions> = {}) {
  proxy = await createAnthropicCompatProxy({
    upstream: 'https://api.anthropic.com', transformRequest: [], ...options,
  });
  return proxy;
}
function send(body: string | Buffer = JSON.stringify(large), headers = {}, path = '/v1/messages') {
  return fetch(`${proxy!.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
}
const decoded = (index = 0) => JSON.parse(gunzipSync(records[index].body).toString('utf8'));

describe('final model request compression', () => {
  it('compresses after routing/transforms; preserves JSON for observers and reports byte metrics only', async () => {
    const observer = vi.fn();
    const debug = vi.fn();
    await start({
      upstream: 'http://unused.invalid',
      routingTransform: () => ({ upstreamOverride: 'https://api.anthropic.com' }),
      transformRequest: [(body) => ({ ...(body as Record<string, unknown>), model: 'claude-rewritten' })],
      responseObserver: observer,
      logger: { debug },
    });
    const response = await send();
    expect(response.status).toBe(200);
    await response.text();
    expect(decoded()).toEqual({ ...large, model: 'claude-rewritten' });
    expect(records[0].headers['content-encoding']).toBe('gzip');
    expect(Number(records[0].headers['content-length'])).toBe(records[0].body.length);
    expect(records[0].body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(large)) / 4);
    expect(JSON.parse(observer.mock.calls[0][0].requestBody.toString())).toEqual(decoded());
    expect(debug.mock.calls.find(([message]) => message === 'request gzip')?.[1]).toEqual({
      reqId: expect.any(Number), originalBytes: expect.any(Number), gzipBytes: records[0].body.length,
      wireBytes: records[0].body.length, compressionMs: expect.any(Number), used: true,
    });
  });

  it.each([
    ['small', JSON.stringify({ model: 'claude-test' }), {}, '/v1/messages'],
    ['already encoded', gzipSync(JSON.stringify(large)), { 'Content-Encoding': 'gzip' }, '/v1/messages'],
    ['other media', JSON.stringify(large), { 'content-type': 'text/plain' }, '/v1/messages'],
    ['other endpoint', JSON.stringify(large), {}, '/v1/other'],
  ])('passes %s requests through without another encoding', async (_name, body, headers, path) => {
    await start();
    await (await send(body as string | Buffer, headers, path as string)).text();
    expect(records[0].body).toEqual(Buffer.from(body as string));
    expect(compressGzip).not.toHaveBeenCalled();
  });

  it('uses the final route: a compatible third-party or local target is not sufficient', async () => {
    await start({ routingTransform: () => ({ upstreamOverride: `http://127.0.0.1:${transport.port}` }) });
    await (await send()).text();
    expect(records[0].headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(records[0].body.toString())).toEqual(large);
    expect(compressGzip).not.toHaveBeenCalled();
  });

  it('keeps the original body for semantic recovery and compresses the corrected retry once', async () => {
    responses = [400, 200];
    await start({ recoveryRules: [{
      id: 'test-forbidden', enabled: () => true, matches: (error) => error.includes('remove forbidden'),
      strip: (body) => {
        const parsed = JSON.parse(body.toString());
        delete parsed.forbidden;
        return Buffer.from(JSON.stringify(parsed));
      },
    }] });
    expect((await send(JSON.stringify({ ...large, forbidden: true }))).status).toBe(200);
    expect(decoded(0).forbidden).toBe(true);
    expect(decoded(1)).toEqual(large);
    expect(records).toHaveLength(2);
  });

  it('does not retry an upstream rejection to guess gzip support', async () => {
    responses = [415];
    await start();
    expect((await send()).status).toBe(415);
    expect(records).toHaveLength(1);
  });

  it('falls back before sending if local compression fails or has insufficient savings', async () => {
    await start();
    vi.mocked(compressGzip).mockRejectedValueOnce(new Error('local zlib failure'));
    await (await send()).text();
    const body = Buffer.from(JSON.stringify(large));
    vi.mocked(compressGzip).mockResolvedValueOnce({ compressed: body, stats: {
      originalBytes: body.length, gzipBytes: body.length, wireBytes: body.length, compressionMs: 0,
    } });
    await (await send()).text();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.body).toEqual(body);
      expect(record.headers['content-encoding']).toBeUndefined();
    }
  });

  // PR #6284: after a 400 recovery, the previous response has ended but no new
  // upstream listener exists during gzip. Its lifecycle must still settle once.
  it.each([
    ['initial', 'owner-changed'], ['initial', 'client-disconnected'], ['initial', 'gate-error'],
    ['retry', 'owner-changed'], ['retry', 'client-disconnected'], ['retry', 'gate-error'],
  ] as const)('settles %s forwarding after %s during compression', async (phase, reason) => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => { markSettled = resolve; });
    let valid = true;
    let gateError = false;
    const lifecycle = { onStart: vi.fn(), onComplete: vi.fn(), onFailure: vi.fn() };
    if (phase === 'retry') {
      responses = [400];
      vi.mocked(compressGzip).mockImplementationOnce(async (body) => {
        const compressed = gzipSync(body);
        return { compressed, stats: { originalBytes: body.length, gzipBytes: compressed.length,
          wireBytes: compressed.length, compressionMs: 0 } };
      });
    }
    vi.mocked(compressGzip).mockImplementationOnce(async (body) => {
      started(); await blocked;
      const compressed = gzipSync(body);
      return { compressed, stats: { originalBytes: body.length, gzipBytes: compressed.length,
        wireBytes: compressed.length, compressionMs: 0 } };
    });
    await start({
      transformRequest: [Object.assign((body: unknown) => body, { onRequestSettled: markSettled })],
      routingTransform: () => ({
        dispatchGenerationValid: () => {
          if (gateError) throw new Error('private gate failure');
          return valid;
        },
        forwardLifecycle: lifecycle,
      }),
      recoveryRules: [{
        id: 'test-retry', enabled: () => true, matches: () => true,
        strip: (body) => body,
      }],
    });
    const abort = new AbortController();
    const pending = fetch(`${proxy!.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(large), signal: abort.signal,
    });
    await entered;
    if (reason === 'owner-changed') valid = false;
    else if (reason === 'gate-error') gateError = true;
    else {
      abort.abort();
      await expect(pending).rejects.toThrow();
      // Wait for the production settlement hook, not only server.close(): the
      // response close event may arrive after dispose's listening socket closes.
      await proxy!.dispose(); proxy = undefined;
      await settled;
    }
    release();
    if (reason === 'owner-changed') expect((await pending).status).toBe(503);
    if (reason === 'gate-error') expect((await pending).status).toBe(502);
    // Drain the deferred continuation, without a timing-based sleep.
    await blocked;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(records).toHaveLength(phase === 'retry' ? 1 : 0);
    expect(lifecycle.onStart).toHaveBeenCalledTimes(phase === 'retry' ? 1 : 0);
    expect(lifecycle.onComplete).not.toHaveBeenCalled();
    if (phase === 'retry') {
      expect(lifecycle.onFailure.mock.calls).toEqual([[
        reason === 'owner-changed' ? 'retry-rejected' : reason === 'gate-error' ? 'retry-error' : 'client-aborted',
        undefined,
      ]]);
    } else {
      expect(lifecycle.onFailure).not.toHaveBeenCalled();
    }
  });

  it('requires an exact supported destination, JSON and a 64 KiB byte threshold', () => {
    const target = { protocol: 'https:', hostname: 'api.anthropic.com', port: 443 };
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    const eligible = (t = target, bytes = 65536, h = headers) => shouldCompressRequest(t, 'POST', '/v1/messages', h, bytes);
    expect(eligible()).toBe(true);
    expect(eligible(target, 65535)).toBe(false);
    for (const hostname of ['localhost', '127.0.0.1', '::1', 'api.openai.com', 'api.anthropic.com.example.com']) {
      expect(eligible({ ...target, hostname })).toBe(false);
    }
    expect(eligible({ ...target, protocol: 'http:' })).toBe(false);
    expect(eligible({ ...target, port: 8443 })).toBe(false);
    expect(eligible(target, 65536, { ...headers, 'Content-Encoding': 'identity' } as typeof headers)).toBe(false);
  });
});
