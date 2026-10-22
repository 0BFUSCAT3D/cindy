import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserControlRequest } from "@cindy/browser-control-runtime";
import { createBrowserMcpServer } from "./server.js";
import { OpenCliPage } from "./opencli-page.js";
import { loadRecipes, RecipeSchema, type Recipe } from "./recipe-loader.js";
import { runRecipe } from "./recipe-runner.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bundled OpenCLI recipes", () => {
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
      for (const id of ['opencli:zlibrary/search', 'opencli:slock/task-create', 'books-list', 'hockey-search']) {
        expect(JSON.stringify(all)).not.toContain(id);
        const response = await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'recipe', recipeId: id } } });
        expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).ok).toBe(false);
      }
      expect(JSON.stringify(all)).toContain('open-library-search');
      expect(JSON.stringify(all)).toContain('steam-reviews');
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
