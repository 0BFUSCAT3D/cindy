import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserControlRequest } from "@cindy/browser-control-runtime";
import { createBrowserMcpServer } from "./server.js";
import { OpenCliPage } from "./opencli-page.js";
import { loadRecipes, RecipeSchema, type Recipe } from "./recipe-loader.js";
import { runRecipe } from "./recipe-runner.js";
import { executeAdapter, type IPage } from '@jackwener/opencli/cindy';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { withRecipeHost, recipeDiagnosticPath, recipeOutputPath, readRecipeFileSync } from '@jackwener/opencli/cindy/host';
import { mkdtemp, writeFile, rm, readFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Pinned upstream adapter helpers ship JavaScript without declarations.
import * as gemini from '../../../opencli-vendor/clis/gemini/utils.js';
// @ts-expect-error Pinned upstream adapter helpers ship JavaScript without declarations.
import * as qwen from '../../../opencli-vendor/clis/qwen/utils.js';
import * as network from '../../../opencli-vendor/src/node-network.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bundled OpenCLI recipes", () => {
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
    vi.spyOn(network, 'fetchWithNodeNetwork').mockImplementation(async () => new Response('image'));
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
      )).rejects.toThrow('output denied by host');
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
        .rejects.toThrow('host output file broker');
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
      expect(result.message).toContain('host file broker');
      expect(call.mock.calls.some(([req]) => req.request?.fn?.includes('atob('))).toBe(false);
      const read = vi.fn(() => Buffer.from('approved-image'));
      const approved = await runRecipe(loadRecipes().get('opencli:yollomi/upload')!, { file }, {
        call, recipeFiles: async () => ({ read, open: () => { throw new Error('unused'); } }),
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
      for (const id of ['opencli:zlibrary/search', 'opencli:slock/task-create', 'opencli:claude/login', 'opencli:claude/ask', 'opencli:spotify/auth', 'opencli:spotify/status', 'books-list', 'hockey-search']) {
        expect(JSON.stringify(all)).not.toContain(id);
        const response = await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'recipe', recipeId: id } } });
        expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).ok).toBe(false);
      }
      expect(JSON.stringify(all)).toContain('open-library-search');
      expect(JSON.stringify(all)).toContain('steam-reviews');
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
