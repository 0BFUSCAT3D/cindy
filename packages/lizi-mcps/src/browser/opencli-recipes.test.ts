import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RecipeBrowserSessions, type BrowserControlRequest } from "@cindy/browser-control-runtime";
import * as guardedNetwork from '@cindy/browser-control-runtime/ssrf-runtime';
import { MockAgent } from 'undici';
import { httpDownload } from '@jackwener/opencli/download';
import * as downloads from '@jackwener/opencli/download';
import { downloadArticle } from '@jackwener/opencli/download/article-download';
import { resolveExistingUploadPaths } from '../../../browser-control-runtime/src/_generated/extension/src/browser/paths.js';
import { createBrowserMcpServer } from "./server.js";
import { OpenCliPage } from "./opencli-page.js";
import { loadRecipes, RecipeSchema, type Recipe } from "./recipe-loader.js";
import { runRecipe } from "./recipe-runner.js";
import { executeAdapter, type IPage } from '@jackwener/opencli/cindy';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { withRecipeHost, recipeDiagnosticPath, recipeOutputPath, readRecipeFileSync } from '@jackwener/opencli/cindy/host';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Pinned upstream adapter helpers ship JavaScript without declarations.
import * as gemini from '../../../opencli-vendor/clis/gemini/utils.js';
// @ts-expect-error Pinned upstream adapter helpers ship JavaScript without declarations.
import * as qwen from '../../../opencli-vendor/clis/qwen/utils.js';
import * as network from '../../../opencli-vendor/src/node-network.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { readUtf8File } from '../../../opencli-vendor/clis/_atlassian/shared.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { resolvePayload } from '../../../opencli-vendor/clis/zhihu/write-shared.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { prepareChatGPTFilePaths } from '../../../opencli-vendor/clis/chatgpt/utils.js';
import { readFileSync, openSync } from 'node:fs';
// @ts-expect-error Upstream JavaScript helpers have no declarations.
import { validateLocalReferences } from '../../../opencli-vendor/clis/midjourney/utils.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bundled OpenCLI recipes", () => {
  // #6826 file boundary recurrence; unit tier. Real adapter input checks must
  // reject an existing absolute path without the host before browser effects.
  it.each(['mercury', 'wechat-channels', 'midjourney'])('brokers %s input metadata before browser effects', async site => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-stat-test-'));
    const file = path.join(dir, site === 'wechat-channels' ? 'clip.mp4' : 'receipt.png');
    await writeFile(file, 'test-only-bytes');
    const goto = vi.fn(async () => { throw new Error('unexpected browser effect'); });
    const page = { goto } as unknown as IPage;
    const run = () => site === 'midjourney' ? validateLocalReferences([{ kind: 'local', value: file }], 'fixture')
      : executeAdapter(site === 'mercury' ? 'mercury/reimbursement-draft' : 'wechat-channels/publish', site === 'mercury' ? {
        receipt: file, amount: '1.00', date: '2026-10-23', merchant: 'Fixture', notes: 'fixture',
      } : { video: file }, page);
    try {
      await expect(run()).rejects.toThrow();
      expect(goto).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 upload regression; real page upload entry + actual external runtime
  // path resolver, unit tier. Source workdir is outside the runtime upload root.
  // Existing screenshot-temp tests never tried a normal adapter upload.
  it.each([false, true])('stages approved uploads in the runtime root and cleans after failure=%s', async fail => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-upload-test-'));
    const uploadRoot = path.join(dir, 'uploads');
    const file = path.join(dir, 'receipt.png');
    await writeFile(file, 'test-only-image');
    let staged = '';
    const page = new OpenCliPage({ targetId: 't', call: async request => {
      expect(request.action).toBe('upload');
      staged = request.paths![0];
      const result = await resolveExistingUploadPaths({ requestedPaths: request.paths!, uploadDir: uploadRoot, inboundMediaDir: path.join(dir, 'inbound') });
      expect(result.ok).toBe(true);
      expect(staged).not.toBe(file);
      expect(await readFile(staged, 'utf8')).toBe('test-only-image');
      return fail ? { ok: false, action: 'upload', message: 'fixture upload rejected' } : { ok: true, action: 'upload', data: {} };
    } });
    try {
      const running = withRecipeHost(undefined, () => page.setFileInput([file]), {
        directory: dir, temporaryRoot: uploadRoot, read: readFileSync, open: file => openSync(file, 'r'),
      });
      if (fail) await expect(running).rejects.toThrow('fixture upload rejected');
      else await running;
      expect(staged).not.toBe('');
      await expect(access(staged)).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe('test-only-image');
    } finally { await page.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 resource-limit regression; real article/download production entries,
  // unit tier with local streams. Old coverage used only a small single image.
  it('limits article image count and leaves remaining links remote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-image-test-'));
    const urls = Array.from({ length: 25 }, (_, i) => `https://example.test/${i}.png`);
    const fetch = vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockImplementation(async params => ({
      response: new Response('image'), finalUrl: params.url, release: async () => {},
    }));
    try {
      await withRecipeHost(undefined, () => downloadArticle({ title: 'Fixture', contentHtml: urls.map(url => `<img src="${url}">`).join(''), imageUrls: urls }, { output: dir }), {
        directory: dir, read: readFileSync, open: file => openSync(file, 'r'), output: file => file,
      });
      expect(fetch).toHaveBeenCalledTimes(20);
      expect(await readdir(path.join(dir, 'Fixture', 'images'))).toHaveLength(20);
      const md = await readFile(path.join(dir, 'Fixture', 'Fixture.md'), 'utf8');
      expect(md).toContain(urls[24]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([8, 10])('counts %s MiB progress across image batches without exceeding the article budget', async sizeMiB => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-total-test-'));
    const urls = Array.from({ length: 16 }, (_, i) => `https://example.test/${i}.png`);
    // Simulate byte progress through the public downloader callback; actual
    // stream rejection/cleanup is covered separately without large disk writes.
    const fetch = vi.spyOn(downloads, 'httpDownload').mockImplementation(async (_url, _path, options) => {
      options?.onProgress?.(sizeMiB * 1024 * 1024, 0);
      await Promise.resolve();
      return { success: true, size: sizeMiB * 1024 * 1024 };
    });
    try {
      await withRecipeHost(undefined, () => downloadArticle({ title: 'Fixture', contentHtml: urls.map(url => `<img src="${url}">`).join(''), imageUrls: urls }, { output: dir }), {
        directory: dir, read: readFileSync, open: file => openSync(file, 'r'), output: file => file,
      });
      expect(fetch).toHaveBeenCalledTimes(sizeMiB === 8 ? 7 : 5);
      const md = await readFile(path.join(dir, 'Fixture', 'Fixture.md'), 'utf8');
      expect(md.match(/images\/img_/g)).toHaveLength(sizeMiB === 8 ? 6 : 5);
      expect(md).toContain(urls[15]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([[true, false], [false, false], [false, true]])('rejects an oversized download before saving (length header=%s, progress rejection=%s)', async (lengthHeader, progressRejection) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-limit-test-'));
    const release = vi.fn(async () => {});
    vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockResolvedValue({
      response: new Response('12345678', { headers: lengthHeader ? { 'content-length': '8' } : {} }),
      finalUrl: 'https://example.test/image', release,
    });
    try {
      const result = await withRecipeHost(undefined, () => httpDownload('https://example.test/image', path.join(dir, 'image.png'), {
        maxBytes: progressRejection ? Infinity : 4,
        onProgress: progressRejection ? () => { throw new Error('Article image byte limit exceeded'); } : undefined,
      }), {
        directory: dir, read: readFileSync, open: file => openSync(file, 'r'), output: file => file,
      });
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/limit/i) });
      expect(await readdir(dir)).toEqual([]);
      expect(release).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 security regression; unit tier. Real download -> real SSRF shell,
  // fake DNS and in-memory HTTP dispatcher. Previously image downloads could
  // reach private literals, private DNS answers and private redirect targets.
  it.each(['http://127.0.0.1/private', 'https://private.example/image', 'https://public.example/redirect'])(
    'does not save bytes from a private download target (%s)', async (url) => {
      const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-network-test-')));
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent.get('https://public.example').intercept({ path: '/redirect' })
        .reply(302, '', { headers: { location: 'http://169.254.169.254/private' } });
      const original = guardedNetwork.fetchWithSsrFGuard;
      vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockImplementation(params => original({
        ...params,
        lookupFn: (async (host: string) => [{ address: host === 'private.example' ? '10.0.0.1' : '8.8.8.8', family: 4 }]) as unknown as guardedNetwork.LookupFn,
        dispatcherFactory: () => agent,
      }));
      // The old unguarded implementation would save these fake private bytes.
      vi.spyOn(network, 'fetchWithNodeNetwork').mockResolvedValue(new Response('private bytes'));
      try {
        const result = await withRecipeHost(undefined, () => httpDownload(url, path.join(dir, 'image.png')), {
          directory: dir, read: readFileSync, open: file => openSync(file, 'r'), output: file => file,
        });
        expect(result).toMatchObject({ success: false, size: 0, error: expect.stringMatching(/blocked/i) });
        expect(await readdir(dir)).toEqual([]);
      } finally { await agent.close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
    },
  );

  // Same production path, public success verifies bytes/MIME/final URL and the
  // shared redirect credential policy; no real network or account is involved.
  it('saves a public redirected download and strips credentials across origins', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-network-test-')));
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.get('https://public.example').intercept({ path: '/image' })
      .reply(302, '', { headers: { location: 'https://cdn.example/image' } });
    agent.get('https://cdn.example').intercept({ path: '/image', headers: headers => {
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      return true;
    } }).reply(200, 'public image', { headers: { 'content-type': 'image/png' } });
    const original = guardedNetwork.fetchWithSsrFGuard;
    vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockImplementation(params => original({
      ...params, lookupFn: (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as guardedNetwork.LookupFn,
      dispatcherFactory: () => agent,
    }));
    try {
      const file = path.join(dir, 'image.png');
      const result = await withRecipeHost(undefined, () => httpDownload('https://public.example/image', file, {
        cookies: 'fake-cookie=fixture', headers: { authorization: 'Bearer fake-fixture' }, includeContentType: true,
      }), { directory: dir, read: readFileSync, open: file => openSync(file, 'r'), output: file => file });
      expect(result).toMatchObject({ success: true, size: 12, contentType: 'image/png', finalUrl: 'https://cdn.example/image' });
      expect(await readFile(file, 'utf8')).toBe('public image');
      expect(await readdir(dir)).toEqual(['image.png']);
    } finally { await agent.close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 networkidle regression; unit tier. Real web/read and capture owner,
  // with multiple polls before loadingFinished; older tests explicitly opted
  // into retention and did not exercise the reader's default polling path.
  it('waits for an unfinished request and its following quiet period before extracting web content', async () => {
    vi.useFakeTimers();
    const sessions = new RecipeBrowserSessions();
    let event = (_method: string, _params: Record<string, unknown>) => {};
    const id = sessions.begin('web', {
      send: async () => ({ body: '{"items":[1]}' }),
      subscribe: listener => { event = listener; return () => {}; }, dispose: () => {},
    });
    const evaluate = vi.fn(async () => ({ title: 'Fixture', contentHtml: '<p>Ready content</p>' }));
    const page = {
      startNetworkCapture: async () => { await sessions.call('web', id, 'Cindy.captureStart'); return true; },
      readNetworkCapture: async (options?: Record<string, unknown>) =>
        (await sessions.call('web', id, 'Cindy.captureRead', options) as { entries: unknown[] }).entries,
      goto: async () => { event('Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://example.test/api' } }); },
      evaluate,
    } as unknown as IPage;
    try {
      const running = executeAdapter('web/read', { url: 'https://example.test', 'wait-until': 'networkidle', wait: 5, stdout: true }, page);
      await vi.advanceTimersByTimeAsync(1500);
      expect(evaluate).not.toHaveBeenCalled();
      event('Network.loadingFinished', { requestId: 'r' });
      await vi.advanceTimersByTimeAsync(500);
      expect(evaluate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await running).toMatchObject([{ markdown: expect.stringContaining('Ready content') }]);
      expect(evaluate).toHaveBeenCalledOnce();
    } finally { sessions.dispose(); }
  });

  // #6826 file-check regression, unit tier. Actual text readers and host IO;
  // older write tests did not inspect relative files before reading them.
  // Two interleaved tasks with the same filename must retain separate content.
  it.each([readUtf8File, (file: string) => resolvePayload({ file }), async (file: string) => {
    const result = await prepareChatGPTFilePaths([file]);
    if (!result.ok) throw new Error(result.reason);
    return readRecipeFileSync(result.paths[0], 'utf8');
  }])('keeps text inspection and reading in each invoking task', async (readText) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-text-test-'));
    const dirs = [path.join(root, 'a'), path.join(root, 'b')];
    try {
      for (const [i, dir] of dirs.entries()) {
        await mkdir(dir);
        await writeFile(path.join(dir, 'page.md'), `task-${i}`);
      }
      const values = await Promise.all(dirs.map((directory) => withRecipeHost(undefined, async () => {
        await Promise.resolve();
        return readText('page.md');
      }, { directory, read: file => readFileSync(file), open: file => openSync(file, 'r') })));
      expect(values).toEqual(['task-0', 'task-1']);
      const read = vi.fn();
      await expect(withRecipeHost(undefined, () => readText('page.md'), {
        directory: dirs[0], read, open: () => { throw new Error('denied by host'); },
      })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      await expect(withRecipeHost(undefined, () => readText('page.md'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Unsupported export modes must be input failures before any navigation or
  // click; they used to perform page actions and then fail on waitForDownload.
  it.each(['video-social', 'gif'])('rejects unsupported export %s before browser execution', async (kind) => {
    const call = vi.fn();
    const result = await runRecipe(loadRecipes().get('opencli:midjourney/download')!, {
      job: '11111111-1111-1111-1111-111111111111', kind,
    }, { call });
    expect(result).toMatchObject({ ok: false, failureKind: 'input' });
    expect(call).not.toHaveBeenCalled();
  });

  // #6826: argument defaults bypassed the task-relative resolver. Unit tier,
  // real adapter -> shared writer with fake generation/network; previous novel
  // coverage did not pass image/download argument defaults through prepareInputs.
  it.each(['gemini/image', 'qwen/image', 'instagram/download'])('saves %s defaults inside the invoking task', async (id) => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-default-test-')));
    const url = 'https://example.test/generated.png';
    const asset = { ok: true, mime: 'image/png', base64: 'aW1hZ2U=' };
    vi.spyOn(gemini, 'startNewGeminiChat').mockResolvedValue(undefined);
    vi.spyOn(gemini, 'getGeminiVisibleImageUrls').mockResolvedValue([]);
    vi.spyOn(gemini, 'sendGeminiMessage').mockResolvedValue(undefined);
    vi.spyOn(gemini, 'waitForGeminiImages').mockResolvedValue([url]);
    vi.spyOn(gemini, 'exportGeminiImages').mockResolvedValue([{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }]);
    for (const name of ['ensureOnQianwen', 'dismissLoginModal', 'startNewChat', 'setFeatureToggle'] as const)
      vi.spyOn(qwen, name).mockResolvedValue(undefined);
    vi.spyOn(qwen, 'sendMessage').mockResolvedValue({ ok: true });
    vi.spyOn(qwen, 'hasLoginGate').mockResolvedValue(false);
    vi.spyOn(qwen, 'getMessageBubbles').mockResolvedValue([{ role: 'Assistant', id: 'answer' }]);
    vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockImplementation(async () => ({
      response: new Response('image'), finalUrl: url, release: async () => {},
    }));
    const outputs: string[] = [];
    const page = {
      goto: async () => {}, wait: async () => {},
      evaluate: async (js: string) => {
        if (js === 'window.location.href') return 'https://example.test/';
        if (id === 'instagram/download') return { ok: true, shortcode: 'B', items: [{ type: 'image', url }] };
        return js.includes('arrayBuffer()') ? asset : [url];
      },
    } as unknown as IPage;
    try {
      await executeAdapter(id, id === 'instagram/download' ? { url: 'https://www.instagram.com/p/B/' } : { prompt: 'fixture' }, page, undefined, undefined, {
        read: () => Buffer.alloc(0), open: () => -1, directory: dir,
        output: file => {
          const relative = path.relative(dir, file);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('output outside task');
          outputs.push(file);
          return file;
        },
      });
      const file = outputs.find(file => /\.(png|jpg)$/.test(file));
      expect(file).toBeDefined();
      expect(await readFile(file!, 'utf8')).toBe('image');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 output/diagnostic review. Unit tier; the real adapter and screenshot
  // entries previously covered reads only. Minimal inputs are one local novel
  // output and two overlapping screenshots with the same diagnostic name.
  it('brokers adapter writes and resolves defaults against the invoking task', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-output-test-')));
    const page = { goto: async () => {}, evaluate: async () => ({
      error: false, body: { id: '1', title: 'Fixture', userName: 'Fixture', userId: '2', content: 'local test text', tags: { tags: [] } },
    }) } as unknown as IPage;
    const inputs = { 'novel-id': '1', execute: true };
    try {
      const rejected = path.join(dir, 'rejected');
      const output = vi.fn(() => { throw new Error('output denied by host'); });
      await expect(executeAdapter('pixiv/novel-download', { ...inputs, output: rejected }, page, undefined, undefined,
        { read: () => Buffer.alloc(0), open: () => -1, directory: dir, output },
      )).rejects.toThrow(/output denied by host|not a safe directory/);
      expect(output).toHaveBeenCalledWith(rejected);
      await expect(access(rejected)).rejects.toThrow();
      const deniedImage = path.join(dir, 'image.png');
      await expect(withRecipeHost(undefined, () => saveBase64ToFile('aW1hZ2U=', deniedImage),
        { read: () => Buffer.alloc(0), open: () => -1, directory: dir, output },
      )).rejects.toThrow('output denied by host');
      await expect(access(deniedImage)).rejects.toThrow();
      const result = await executeAdapter('pixiv/novel-download', inputs, page, undefined, undefined,
        { read: () => Buffer.alloc(0), open: () => -1, directory: dir, output: file => file },
      ) as Array<{ path: string }>;
      expect(result[0].path).toBe(path.join(dir, 'pixiv-downloads', 'novels', '1.txt'));
      expect(await readFile(result[0].path, 'utf8')).toContain('local test text');
      const screenshot = new OpenCliPage({ targetId: 'fixture', call: async request => ({
        ok: true, action: request.action, data: { data: 'aW1hZ2U=' },
      }) });
      await withRecipeHost(undefined, () => screenshot.screenshot({ path: deniedImage }),
        { read: () => Buffer.alloc(0), open: () => -1, directory: dir, output: file => file });
      expect(await readFile(deniedImage, 'utf8')).toBe('image');
      await expect(executeAdapter('pixiv/novel-download', { ...inputs, output: path.join(dir, 'no-host') }, page))
        .rejects.toThrow(/host output file broker|not a safe directory/);
      await expect(access(path.join(dir, 'no-host'))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('isolates overlapping diagnostics and cleans both fulfilled and rejected calls', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const paths: string[] = [];
    const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const late = Promise.withResolvers<void>();
    let lateAttempt!: Promise<string>;
    const run = (index: number) => withRecipeHost(undefined, async () => {
      const file = recipeDiagnosticPath('same-name.png');
      paths[index] = file;
      const page = new OpenCliPage({ targetId: 'fixture', call: async request => ({
        ok: true, action: request.action, data: { data: Buffer.from(`image-${index}`).toString('base64') },
      }) });
      await page.screenshot({ path: file });
      expect(readRecipeFileSync(file, 'utf8')).toBe(`image-${index}`);
      if (index === 0) lateAttempt = late.promise.then(() => recipeOutputPath(file));
      ready[index].resolve();
      await hold;
      if (index === 1) throw new Error('cancelled fixture');
    });
    const running = [run(0), run(1)];
    try {
      await Promise.all(ready.map(entry => entry.promise));
      expect(paths[0]).not.toBe(paths[1]);
      expect(await Promise.all(paths.map(file => readFile(file, 'utf8')))).toEqual(['image-0', 'image-1']);
    } finally { release(); }
    expect((await Promise.allSettled(running)).map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    late.resolve();
    await expect(lateAttempt).rejects.toThrow('active host file broker');
    for (const file of paths) await expect(access(path.dirname(file))).rejects.toThrow();
  });

  // #6826 security review: real adapter entries, unit tier with fake browser
  // and network. Existing tests did not cover cross-site cookies or direct
  // file reads. Minimal inputs: foreign cookie and an unbrokered local PNG.
  it('does not forward foreign cookies when the browser returns mixed domains', async () => {
    const getCookies = vi.fn(async () => [
      { name: 'session', value: 'fake-own', domain: '.chatgpt.com' },
      { name: 'foreign', value: 'fake-private', domain: '.example.test' },
      { name: 'suffix', value: 'fake-private', domain: '.evilchatgpt.com' },
    ]);
    const fetch = vi.fn(async () => { throw new Error('captured request'); });
    vi.stubGlobal('fetch', fetch);
    const page = {
      nativeClick: vi.fn(), getCookies,
      evaluate: async (js: string) => js === 'window.location.href'
        ? 'https://chatgpt.com/new'
        : { isLoggedIn: true, hasComposer: true, hasLoginGate: false, model: 'fast', found: false },
    } as unknown as IPage;
    await expect(executeAdapter('chatgpt/model', { model: 'advanced' }, page)).rejects.toThrow('captured request');
    expect(fetch).toHaveBeenCalled();
    const request = fetch.mock.calls[0] as unknown as [string, { headers: { cookie: string } }];
    expect(request[1].headers.cookie).toBe('session=fake-own');
    expect(getCookies.mock.calls.every(args => args.length > 0)).toBe(true);
  });

  it('refuses direct media reads without the host file broker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-media-test-'));
    try {
      const file = path.join(dir, 'private.png');
      await writeFile(file, 'fake-private-image');
      const call = vi.fn(async (request: BrowserControlRequest) => ({
        ok: true, action: request.action, data: { targetId: 't', result: request.request?.fn?.includes('atob(')
          ? { ok: true, data: { url: 'https://example.test/uploaded' } } : 'https://yollomi.com' },
      }));
      const result = await runRecipe(loadRecipes().get('opencli:yollomi/upload')!, { file }, { call });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('file broker');
      expect(call.mock.calls.some(([req]) => req.request?.fn?.includes('atob('))).toBe(false);
      const read = vi.fn(() => Buffer.from('approved-image'));
      const approved = await runRecipe(loadRecipes().get('opencli:yollomi/upload')!, { file }, {
        call, recipeFiles: async () => ({ read, output: file => file, open: () => { throw new Error('unused'); } }),
      });
      expect(approved.ok).toBe(true);
      expect(read).toHaveBeenCalledWith(file);
      expect(call.mock.calls.some(([req]) => req.request?.fn?.includes(Buffer.from('approved-image').toString('base64')))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // Review #6826: goto must await the requested DOM settle interval on both
  // initial open and existing-tab navigation. Unit tier, real page JS with
  // fake timers/DOM; no prior adapter test exercised navigation options.
  it.each([undefined, 'existing-target'])('honors navigation settlement from target %s', async (targetId) => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { body: {} });
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    const call = vi.fn(async (request: BrowserControlRequest) => ({
      ok: true, action: request.action,
      data: request.action === 'act'
        ? { result: await Function(`return (${request.request!.fn})`)()() }
        : { targetId: 'live-target' },
    }));
    const page = new OpenCliPage({ targetId, call });
    let completed = false;
    const navigation = page.goto('https://example.test', { settleMs: 80 }).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(79);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await navigation;
    expect(completed).toBe(true);
    expect(call.mock.calls[0][0].action).toBe(targetId ? 'navigate' : 'open');
    call.mockClear();
    await page.goto('https://example.test/next', { waitUntil: 'none', settleMs: 80 });
    expect(call.mock.calls.map(([request]) => request.action)).toEqual(['navigate']);
  });

  // Review #6826: a fresh tab must remain selected when recovery closes the old
  // tab by ID or index; closing the current tab clears it. Unit/public page API.
  it.each(['old-target', 0])('preserves the fresh target when closing old tab %s', async (target) => {
    const calls: BrowserControlRequest[] = [];
    const page = new OpenCliPage({ targetId: 'old-target', call: async (request) => {
      calls.push(request);
      return { ok: true, action: request.action, data: request.action === 'tabs'
        ? { tabs: [{ targetId: 'old-target' }, { targetId: 'fresh-target' }] }
        : request.action === 'close' ? { tabId: request.targetId }
        : { sessionId: 's', cookies: [], result: 'fresh content' } };
    } });
    await page.getCookies();
    page.setActivePage('fresh-target');
    await page.closeTab(target);
    expect(page.getActivePage()).toBe('fresh-target');
    expect(await page.evaluate('document.title')).toBe('fresh content');
    expect(calls.find(call => call.action === 'close')?.targetId).toBe('old-target');
    expect(calls.find(call => call.recipeCommand?.method === 'Cindy.end')?.targetId).toBe('old-target');
    expect(calls.at(-1)?.targetId).toBe('fresh-target');
    await page.closeTab();
    expect(page.getActivePage()).toBeUndefined();
    await page.dispose();
  });

  it("executes a legacy alias through the real adapter with its original parameter name", async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            info: { name: "example-test", version: "1.2.3" },
            releases: {},
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const call = vi.fn();
    const result = await runRecipe(
      loadRecipes().get("pypi-package")!,
      { package: "example-test" },
      { call },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject([
      { name: "example-test", latestVersion: "1.2.3" },
    ]);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://pypi.org/pypi/example-test/json",
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("runs a browser pipeline with numeric defaults and the newly returned target", async () => {
    const calls: BrowserControlRequest[] = [];
    const result = await runRecipe(
      loadRecipes().get("bilibili-hot")!,
      {},
      {
        call: async (request) => {
          calls.push(request);
          return {
            ok: true,
            action: request.action,
            data:
              request.action === "open"
                ? { tabId: "new-target" }
                : { result: [{ title: "Example", bvid: "BV-test" }] },
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject([{ rank: 1, title: "Example" }]);
    expect(calls[1].targetId).toBe("new-target");
    expect(calls.filter(call => call.action === 'act').map(call => call.request?.fn))
      .toEqual(expect.arrayContaining([expect.stringContaining('ps=20')]));
  });

  it("rejects invalid numeric inputs before any browser operation", async () => {
    const call = vi.fn();
    const result = await runRecipe(
      loadRecipes().get("opencli:bilibili/hot")!,
      { limit: "1;alert(1)" },
      { call },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe('input');
    expect(call).not.toHaveBeenCalled();
  });

  // #6822 compatibility: existing native-step tests do not cover adapter preflight
  // or persistence of an adapter with empty steps. Real MCP entry, unit tier;
  // minimum input is an invalid limit, followed by one failed browser attempt.
  it('keeps adapters usable after bad inputs and persists real failures across sessions', async () => {
    const saved = new Map<string, Recipe>();
    let version = 0;
    const call = vi.fn(async (request: BrowserControlRequest) => ({
      ok: false, action: request.action, message: 'page unavailable',
    }));
    const connect = async () => {
      const server = createBrowserMcpServer({
        getRuntime: () => ({ call }),
        getUserRecipes: async () => ({ version: `adapter-maintenance-${version}`, recipes: saved, siteGuides: new Map() }),
        saveUserRecipe: async ({ recipe }) => {
          const parsed = RecipeSchema.parse(recipe);
          saved.set(parsed.id, parsed);
          version++;
          return { ok: true };
        },
      });
      const client = new Client({ name: 'adapter-maintenance', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      return { server, client };
    };
    const run = async (client: Client, inputs: Record<string, unknown>) => {
      const response = await client.callTool({ name: 'call_tool', arguments: {
        name: 'browser', args: { action: 'recipe', recipeId: 'opencli:bilibili/hot', inputs },
      } });
      return JSON.parse((response.content as Array<{ text: string }>)[0].text);
    };
    const first = await connect();
    try {
      expect(await run(first.client, { limit: 'bad' })).toMatchObject({ ok: false, failureKind: 'input' });
      expect(saved.size).toBe(0);
      expect(call).not.toHaveBeenCalled();
      expect(await run(first.client, { limit: 1 })).toMatchObject({ ok: false, failureKind: 'action' });
      expect(saved.get('opencli:bilibili/hot')).toMatchObject({ adapter: 'bilibili/hot', validation: { state: 'suspended' } });
    } finally {
      await first.client.close();
      await first.server.close();
    }
    const attempts = call.mock.calls.length;
    const next = await connect();
    try {
      expect((await run(next.client, { limit: 1 })).message).toContain('暂停');
      expect(call).toHaveBeenCalledTimes(attempts);
    } finally {
      await next.client.close();
      await next.server.close();
    }
  });

  it("does not replay a write after the browser reports an unknown outcome", async () => {
    let writes = 0;
    const result = await runRecipe(
      loadRecipes().get("opencli:twitter/like")!,
      { url: "https://x.com/example/status/12345" },
      {
        targetId: "t",
        call: async (request) => {
          const fn = (request.request as { fn?: string } | undefined)?.fn ?? "";
          if (fn.includes("writeStarted")) {
            writes++;
            return {
              ok: false,
              action: request.action,
              message: "connection lost after dispatch",
            };
          }
          return { ok: true, action: request.action, data: { result: true } };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(writes).toBe(1);
  });

  it("preserves the CDP session and screenshot bytes, then releases resources", async () => {
    const calls: BrowserControlRequest[] = [];
    const page = new OpenCliPage({
      targetId: "t",
      call: async (request) => {
        calls.push(request);
        return {
          ok: true,
          action: request.action,
          data:
            request.action === "screenshot"
              ? { data: "aW1hZ2U=" }
              : { sessionId: "s", cookies: [] },
        };
      },
    });
    await page.getCookies();
    await page.cdp("DOM.getDocument");
    expect(await page.screenshot()).toBe("aW1hZ2U=");
    await page.dispose();
    expect(
      calls.filter((call) => call.recipeCommand?.method === "Cindy.begin"),
    ).toHaveLength(1);
    expect(
      calls
        .filter(
          (call) =>
            call.recipeCommand && call.recipeCommand.method !== "Cindy.begin",
        )
        .every((call) => call.recipeCommand?.sessionId === "s"),
    ).toBe(true);
    expect(calls.at(-1)?.recipeCommand?.method).toBe("Cindy.end");
  });

  // Product decision 2026-10-23: exclusions must disappear from discovery and
  // execution, while independent Cindy recipes remain discoverable. Unit tier;
  // the previous all-catalog assertion did not cover this selected-catalog contract.
  it("exposes the selected catalog and rejects excluded recipes through the public MCP entry", async () => {
    const server = createBrowserMcpServer({
      getRuntime: () => ({ call: vi.fn() }),
    });
    const client = new Client({ name: "recipe-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const query = async (site?: string) => {
      const response = await client.callTool({
        name: "call_tool",
        arguments: {
          name: "browser",
          args: { action: "siteguide", ...(site ? { site } : {}) },
        },
      });
      return JSON.parse((response.content as Array<{ text: string }>)[0].text);
    };
    try {
      const all = await query();
      expect(all.ok).toBe(true);
      expect(all.recipeCount).toBe(loadRecipes().size);
      for (const id of ['opencli:zlibrary/search', 'opencli:slock/task-create', 'opencli:claude/login', 'opencli:claude/ask', 'opencli:spotify/auth', 'opencli:spotify/status', 'opencli:ones/login', 'opencli:ones/token-info', 'books-list', 'hockey-search']) {
        expect(JSON.stringify(all)).not.toContain(id);
        const response = await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'recipe', recipeId: id } } });
        expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).ok).toBe(false);
      }
      expect(JSON.stringify(all)).toContain('open-library-search');
      expect(JSON.stringify(all)).toContain('steam-reviews');
      const midjourney = await query('midjourney');
      expect(midjourney.recipes.find((recipe: { id: string }) => recipe.id === 'opencli:midjourney/download').parameters.kind.choices)
        .toEqual(['auto', 'image', 'video-raw']);
      // The public guide must describe the same task-relative defaults used by
      // execution; otherwise callers can reintroduce an out-of-task path.
      for (const [site, command, arg, expected] of [
        ['gemini', 'image', 'op', './gemini-images'],
        ['qwen', 'image', 'op', './qianwen-images'],
        ['instagram', 'download', 'path', './instagram-downloads'],
        ['midjourney', 'download', 'output', './midjourney-downloads'],
      ]) {
        const guide = await query(site);
        expect(guide.recipes.find((recipe: { id: string }) => recipe.id === `opencli:${site}/${command}`).parameters[arg].default).toBe(expected);
      }
      const site = await query("bilibili");
      expect(site.ok).toBe(true);
      expect(
        site.recipes.find(
          (recipe: { id: string }) => recipe.id === "opencli:bilibili/hot",
        ).parameters.limit.default,
      ).toBe(20);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
