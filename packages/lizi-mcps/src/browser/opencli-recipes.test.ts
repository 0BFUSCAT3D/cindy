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
import { OpenCliPage, runOpenCliAdapter } from "./opencli-page.js";
import { loadRecipes, RecipeSchema, type Recipe } from "./recipe-loader.js";
import { runRecipe } from "./recipe-runner.js";
import { executeAdapter, type IPage } from '@jackwener/opencli/cindy';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { withRecipeHost, recipeDiagnosticPath, recipeOutputPath, recipeCopySource, readRecipeFileSync, readSecretJSON, writeSecretJSON } from '@jackwener/opencli/cindy/host';
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
import { readFileSync, writeFileSync, openSync, fstatSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { AsyncResource } from 'node:async_hooks';
// @ts-expect-error Upstream JavaScript helpers have no declarations.
import { validateLocalReferences } from '../../../opencli-vendor/clis/midjourney/utils.js';
// @ts-expect-error Pinned upstream JavaScript uploader has no declarations.
import { tosUpload } from '../../../opencli-vendor/clis/douyin/_shared/tos-upload.js';
// @ts-expect-error Pinned upstream JavaScript media helpers have no declarations.
import * as instagramMedia from '../../../opencli-vendor/clis/instagram/_shared/private-publish.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { downloadRemoteImage, MAX_IMAGE_SIZE_BYTES } from '../../../opencli-vendor/clis/twitter/utils.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { s2Fetch } from '../../../opencli-vendor/clis/semanticscholar/utils.js';
// @ts-expect-error Pinned upstream JavaScript helpers have no declarations.
import { buildEutilsUrl } from '../../../opencli-vendor/clis/pubmed/utils.js';

// Wrap the native namespace so tests can replace only the subprocess boundary.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bundled OpenCLI recipes", () => {
  // #6826 foreground regression, unit tier. Use the real login adapter/page
  // with an in-memory transport: previous navigation tests omitted metadata.
  it.each([undefined, 'existing-target'])('focuses interactive login before probing from %s', async targetId => {
    const calls: BrowserControlRequest[] = [];
    const result = await runOpenCliAdapter('midjourney/login', {}, { targetId, call: async request => {
      calls.push(request);
      const fn = request.request?.fn ?? '';
      return { ok: true, action: request.action, data: request.action === 'open'
        ? { targetId: 'login-target' }
        : { result: fn.includes('location.hostname') ? 'www.midjourney.com'
          : fn.includes('/api/subscriptions-check') ? { ok: true, status: 200,
            text: JSON.stringify({ user_id: 'fixture', status: 'active', plan: { type: 'fixture' } }) }
            : true } };
    } });
    expect(result).toMatchObject({ status: 'already_logged_in', logged_in: true });
    expect(calls.slice(0, 2).map(request => request.action)).toEqual([targetId ? 'navigate' : 'open', 'focus']);
    expect(calls[1].targetId).toBe(targetId ?? 'login-target');
    if (!targetId) expect(calls[0].background).toBe(false);
  });

  it('surfaces a foreground focus failure before login polling starts', async () => {
    const calls: BrowserControlRequest[] = [];
    await expect(runOpenCliAdapter('midjourney/login', {}, { targetId: 'login-target', call: async request => {
      calls.push(request);
      if (request.action === 'act') throw new Error('probe started before focus');
      return request.action === 'focus'
        ? { ok: false, action: request.action, message: 'fixture focus unavailable' }
        : { ok: true, action: request.action, data: { result: true } };
    } })).rejects.toThrow('fixture focus unavailable');
    expect(calls.map(request => request.action)).toEqual(['navigate', 'focus']);
  });

  // Forced screenshots have no opt-out. Exclusion must happen at discovery
  // and direct execution, before drawing mutates a user's canvas (unit tier).
  it.each(['geogebra/triangle', 'geogebra/hexagon'])('defers mandatory file export %s before page effects', async id => {
    const effect = vi.fn(async () => { throw new Error('unexpected canvas mutation'); });
    const start = vi.fn();
    await expect(executeAdapter(id, {}, new Proxy({}, { get: () => effect }) as IPage, undefined, start))
      .rejects.toThrow('Unknown bundled adapter');
    expect(loadRecipes().has(`opencli:${id}`)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  // #6826 export-mode recurrence, unit tier. Earlier tests only exercised
  // link flags and web/stdout, missing optional archive/browser-download modes.
  // Every retired argument must disappear and fail before execution begins.
  it('rejects retired export arguments before any browser or network effect', async () => {
    const cases: Array<[string, Record<string, unknown>, string, unknown]> = [
      ['twitter/bookmarks', { all: true }, 'resume-file', 'resume.json'],
      ['twitter/bookmarks', { all: true }, 'output-file', 'archive.jsonl'],
      ['twitter/likes', { username: 'fixture', all: true }, 'resume-file', 'resume.json'],
      ['twitter/likes', { username: 'fixture', all: true }, 'output-file', 'archive.jsonl'],
      ['band/post', { band_no: '1', post_no: '2' }, 'output', 'photos'],
      ['doubao/meeting-transcript', { id: '123' }, 'download', true],
      ['doubao/meeting-transcript', { id: '123' }, 'download', 'true'],
      ['web/read', { url: 'https://example.test' }, 'output', 'articles'],
      ['web/read', { url: 'https://example.test' }, 'download-images', true],
      ['midjourney/generate', { prompt: 'fixture' }, 'output', 'images'],
      ...['background', 'edit', 'face-swap', 'generate', 'object-remover', 'remove-bg', 'restore', 'try-on', 'upscale', 'video']
        .map(name => [`yollomi/${name}`, {}, 'output', 'images'] as [string, Record<string, unknown>, string, unknown]),
    ];
    const effect = vi.fn(async () => { throw new Error('unexpected page effect'); });
    const page = new Proxy({}, { get: () => effect }) as IPage;
    const start = vi.fn();
    for (const [id, required, key, value] of cases) {
      await expect(executeAdapter(id, { ...required, [key]: value }, page, undefined, start))
        .rejects.toThrow('Local recipe file export');
      expect(loadRecipes().get(`opencli:${id}`)!.inputs).not.toHaveProperty(key);
    }
    expect(start).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it('keeps Band photo links and Doubao transcript text available without exports', async () => {
    const band = { goto: async () => {}, getCookies: async () => [{ name: 'band_session', value: 'invalid-fixture' }],
      evaluate: async () => ({ text: 'Fixture post', photos: ['https://example.test/photo.png'] }),
    } as unknown as IPage;
    expect(await executeAdapter('band/post', { band_no: '1', post_no: '2' }, band))
      .toMatchObject([{ type: 'post', text: expect.stringContaining('https://example.test/photo.png') }]);
    const evaluate = vi.fn(async (_js: string) => 'Fixture transcript');
    const doubao = { goto: async () => {}, wait: async () => {}, evaluate } as unknown as IPage;
    expect(await executeAdapter('doubao/meeting-transcript', { id: '123' }, doubao))
      .toEqual([{ Section: 'Transcript', Content: 'Fixture transcript' }]);
    expect(evaluate.mock.calls.every(args => !String(args[0]).includes('minutes-download-text-btn'))).toBe(true);
    expect(loadRecipes().get('opencli:mubu/doc')!.inputs).toHaveProperty('output');
  });

  // Unsupported adapter API regression: real adapter + real OpenCliPage,
  // fake transport and timers. Old page.waitForTimeout always throws after goto.
  it('runs Maimai talent search using the supported five-second delay', async () => {
    vi.useFakeTimers();
    const calls: BrowserControlRequest[] = [];
    const page = new OpenCliPage({ targetId: 'fixture', call: async request => {
      calls.push(request);
      const method = request.recipeCommand?.method;
      return { ok: true, action: request.action, data: method === 'Cindy.begin' ? { sessionId: 'fixture-session' }
        : method === 'Network.getCookies' ? { cookies: [] }
          : { result: request.request?.fn?.includes('api/ent/discover/search')
            ? { code: 0, data: { list: [{ name: 'Fixture candidate', company: 'Fixture company' }] } } : true } };
    } });
    try {
      const result = executeAdapter('maimai/search-talents', { query: 'fixture' }, page);
      const checked = expect(result).resolves.toMatchObject([{ name: 'Fixture candidate', company: 'Fixture company' }]);
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls.some(call => call.request?.fn?.includes('api/ent/discover/search'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await checked;
    } finally { await page.dispose(); }
  });

  // #6826 download recurrence, unit tier. Generic downloader tests missed the
  // X composer consumer; real DNS/redirect policy with an in-memory dispatcher.
  it.each(['http://127.0.0.1/private', 'https://private.example/image', 'https://public.example/redirect'])(
    'rejects private X image downloads before exposing upload bytes (%s)', async url => {
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
      const direct = vi.fn(async () => new Response('private bytes', { headers: { 'content-type': 'image/png' } }));
      vi.stubGlobal('fetch', direct);
      try {
        await expect(withRecipeHost(undefined, () => downloadRemoteImage(url))).rejects.toThrow(/blocked/i);
        expect(direct).not.toHaveBeenCalled();
      } finally { await agent.close().catch(() => undefined); }
    },
  );

  // First oversized chunk and absent/false length headers: cancel with bounded
  // pipe read-ahead rather than buffering the full body as the old consumer did.
  it.each(['missing', 'understated', 'oversized'])('bounds X image streams with %s Content-Length', async header => {
    const release = vi.fn(async () => {});
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (pull.mock.calls.length === 1) controller.enqueue(new Uint8Array(MAX_IMAGE_SIZE_BYTES + 1));
      else if (pull.mock.calls.length < 4) controller.enqueue(new Uint8Array(1));
      else controller.close();
    });
    const headers: Record<string, string> = { 'content-type': 'image/png' };
    if (header !== 'missing') headers['content-length'] = header === 'understated' ? '1' : String(MAX_IMAGE_SIZE_BYTES + 1);
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockResolvedValue({ response, finalUrl: 'https://cdn.example/image', release });
    await expect(withRecipeHost(undefined, () => downloadRemoteImage('https://public.example/image'))).rejects.toThrow(/limit/i);
    if (header === 'oversized') expect(pull).not.toHaveBeenCalled();
    else expect(pull.mock.calls.length).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['success', 'http-error', 'unsupported-type'])('cleans X image temporary files after %s', async outcome => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-x-image-test-'));
    const release = vi.fn(async () => {});
    const response = new Response('public bytes', { status: outcome === 'http-error' ? 500 : 200,
      headers: { 'content-type': outcome === 'unsupported-type' ? 'text/plain' : 'image/png' } });
    vi.spyOn(guardedNetwork, 'fetchWithSsrFGuard').mockResolvedValue({ response, finalUrl: 'https://cdn.example/image', release });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    try {
      const running = withRecipeHost(undefined, async () => {
        const image = await downloadRemoteImage('https://public.example/image');
        expect(path.extname(image.absPath)).toBe('.png');
        expect(await readFile(image.absPath, 'utf8')).toBe('public bytes');
      }, { temporaryRoot: dir, read: readFileSync, open: file => openSync(file, 'r') });
      if (outcome === 'success') await running;
      else await expect(running).rejects.toThrow(outcome === 'http-error' ? /500/ : /Unsupported/);
      expect(release).toHaveBeenCalledOnce();
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // Credential-family audit, unit tier. Optional public APIs must not inherit
  // reusable launch-environment keys. Existing tests never supplied such keys.
  it('keeps public research APIs anonymous even with ambient API keys', async () => {
    vi.stubEnv('SEMANTIC_SCHOLAR_API_KEY', 'invalid-fixture-s2-key');
    vi.stubEnv('NCBI_API_KEY', 'invalid-fixture-ncbi-key');
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await s2Fetch('https://api.semanticscholar.org/graph/v1/paper/search?query=fixture', 'fixture');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('x-api-key');
    expect(new URL(buildEutilsUrl('esearch', { term: 'fixture' })).searchParams.has('api_key')).toBe(false);
  });
  // #6826 source-copy TOCTOU, unit tier. The shared copy entry must return an
  // invocation-owned snapshot, not the original path after approving its bytes.
  // Earlier converter cases did not exercise this separate copy source entry.
  it('copies approved bytes instead of reopening a replaced source path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-copy-test-'));
    const source = path.join(dir, 'source.png');
    await writeFile(source, 'approved');
    let copy = '';
    try {
      await withRecipeHost(undefined, async () => {
        copy = recipeCopySource(source);
        expect(copy).not.toBe(source);
        expect(await readFile(copy, 'utf8')).toBe('approved');
      }, { directory: dir, read: file => {
        const bytes = readFileSync(file); writeFileSync(file, 'replacement'); return bytes;
      }, open: file => openSync(file, 'r') });
      await expect(access(copy)).rejects.toThrow();
      expect(await readFile(source, 'utf8')).toBe('replacement');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 file boundary: actual media preparation / story entry, unit tier.
  // Prior upload tests never exercised converters reopening a checked path.
  // Replace the original immediately after broker approval; subprocess fakes
  // must still see approved bytes. Native macOS capability stays platform-owned.
  it.each(['feed', 'story', 'video', 'video-story', 'conversion-failure'])('isolates %s conversion from source replacement and cleans staged bytes', async kind => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-convert-test-'));
    const video = kind.startsWith('video');
    const file = path.join(dir, video ? 'clip.mp4' : 'image.png');
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(4, 16);
    png.writeUInt32BE(40, 20);
    const approved = video ? Buffer.from('approved-video') : Buffer.concat([png, Buffer.from('approved')]);
    const replaced = video ? Buffer.from('unapproved-video') : Buffer.concat([png, Buffer.from('unapproved')]);
    await writeFile(file, approved);
    const inputs: string[] = [];
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[]) => {
      const input = args[command === 'sips' ? 5 : 1];
      inputs.push(input);
      expect(input).not.toBe(file);
      const bytes = readFileSync(input);
      expect([approved.toString('hex'), Buffer.from('trimmed-video').toString('hex')]).toContain(bytes.toString('hex'));
      if (kind === 'conversion-failure') return { status: 1, stderr: 'fixture conversion failed', stdout: '' };
      if (command === 'sips') writeFileSync(args[7], approved);
      else if (args.length === 2) return { status: 0, stdout: JSON.stringify({ width: 100, height: 100,
        durationMs: bytes.equals(approved) ? 20000 : 10000 }), stderr: '' };
      else writeFileSync(args[2], args.length === 4 ? Buffer.from('trimmed-video')
        : Buffer.from('ffd8ffc0000b08000100010101110000', 'hex'));
      return { status: 0, stdout: '{}', stderr: '' };
    }) as typeof childProcess.spawnSync);
    const run = () => kind === 'video-story' ? instagramMedia.publishStoryViaPrivateApi({
      page: {}, mediaItem: { type: 'video', filePath: file }, currentUserId: 'fixture-user', apiContext: {},
      fetcher: async () => new Response(JSON.stringify({ status: 'ok', media: { pk: 'fixture-pk' } })),
    }) : Promise.resolve(video ? instagramMedia.readVideoAsset(file)
      : kind === 'story' ? instagramMedia.prepareImageAssetForPrivateStoryUpload(file)
        : instagramMedia.prepareImageAssetForPrivateUpload(file));
    try {
      const result = withRecipeHost(undefined, run, {
        directory: dir, temporaryRoot: dir, open: candidate => openSync(candidate, 'r'),
        read: candidate => { const bytes = readFileSync(candidate); writeFileSync(candidate, replaced); return bytes; },
      });
      if (process.platform !== 'darwin' || kind === 'conversion-failure') {
        await expect(result).rejects.toThrow(process.platform !== 'darwin' ? 'does not support' : 'failed to normalize');
      } else {
        const asset = await result;
        if (kind === 'video-story') expect(asset).toMatchObject({ mediaPk: 'fixture-pk' });
        else expect(asset).toMatchObject({ bytes: approved });
        expect(inputs.length).toBeGreaterThan(0);
      }
      if (process.platform !== 'darwin') expect(spawn).not.toHaveBeenCalled();
      for (const input of inputs) await expect(access(input)).rejects.toThrow();
      expect(await readFile(file)).toEqual(replaced);
      expect(await readdir(dir)).toEqual([path.basename(file)]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 file-state recurrence, unit tier. Real uploader and broker-approved
  // descriptors; old tests never reached multipart init with task-only files.
  // The old resume write fails after init, before any part can be transferred.
  it.each([null, 'init', 'transfer', 'finish'])('uploads without disk state and closes the input after failure at %s', async fail => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-tos-test-'));
    const file = path.join(dir, 'clip.mp4');
    await writeFile(file, 'fixture-video');
    const opened: number[] = [];
    const phases: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const phase = new URL(url).searchParams.get('phase')!;
      phases.push(phase);
      if (phase === 'init') return new Response('<UploadId>invalid-fixture-upload</UploadId>', { status: fail === phase ? 500 : 200 });
      if (phase === 'transfer') {
        expect(Buffer.from(init.body as Uint8Array).toString()).toBe('fixture-video');
        return new Response(JSON.stringify({ code: fail === phase ? 4000 : 2000, data: { crc32: 'fixture-crc' } }));
      }
      return new Response(JSON.stringify({ code: fail === phase ? 4000 : 2000, data: { key: 'fixture-completed' } }));
    });
    vi.stubGlobal('fetch', fetch);
    const output = vi.fn(() => { throw new Error('no extra disk state'); });
    const run = () => tosUpload({ filePath: 'clip.mp4', uploadInfo: {
      tos_upload_url: 'https://upload.example.test/video', auth: 'invalid-fixture-auth',
    } });
    try {
      await expect(withRecipeHost(undefined, run, {
        directory: dir, read: () => { throw new Error('input rejected'); },
        open: () => { throw new Error('input rejected'); }, output,
      })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      const inputOnlyOutput = vi.fn((candidate: string) => {
        if (candidate === file) return candidate;
        throw new Error('no extra disk state');
      });
      const running = withRecipeHost(undefined, run, {
        directory: dir, read: readFileSync,
        open: file => { const fd = openSync(file, 'r'); opened.push(fd); return fd; }, output: inputOnlyOutput,
      });
      if (fail) await expect(running).rejects.toThrow(fail === 'init' ? 'TOS init multipart upload failed'
        : fail === 'transfer' ? 'TOS upload part 1 failed' : 'TOS complete multipart upload failed');
      else expect(await running).toBe('fixture-completed');
      expect(phases).toEqual(fail === 'init' ? ['init'] : fail === 'transfer' ? ['init', 'transfer'] : ['init', 'transfer', 'finish']);
      expect(output).not.toHaveBeenCalled();
      expect(inputOnlyOutput).not.toHaveBeenCalled();
      expect(opened).toHaveLength(1);
      expect(() => fstatSync(opened[0])).toThrow();
      expect(await readdir(dir)).toEqual(['clip.mp4']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // #6826 quota regression, unit tier. Actual adapter result must survive a
  // broker denying all optional files; older coverage never ran quota/account.
  it.each(['quota', 'account'])('returns current Midjourney %s without historical snapshot files', async command => {
    const io = vi.fn(() => { throw new Error('host denied optional state'); });
    const result = await executeAdapter(`midjourney/${command}`, {}, {
      goto: async () => {}, fetchJson: async () => ({ user_id: 'fixture-user', plan: { type: 'basic' }, total_credits: 120000, period_credits_used: 60000 }),
    } as unknown as IPage, undefined, undefined, { directory: tmpdir(), read: io, open: io, output: io });
    expect(result).toMatchObject([{ plan: 'basic', remaining_minutes: 2, used_minutes: 1,
      avg_daily_minutes: null, projected_exhaustion_date: null }]);
    expect(io).not.toHaveBeenCalled();
  });

  // #6826 credentials-and-local-storage: production broker, unit tier. Prior
  // file tests did not cover a missing encrypted entry with a legacy file present.
  // Only invalid fixture credentials are written under an isolated temp root.
  it('keeps secret reads and writes in the invoking host store, including missing entries and late calls', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-recipe-secret-test-'));
    const legacy = path.join(dir, 'legacy.json');
    await writeFile(legacy, JSON.stringify({ access_token: 'invalid-legacy-fixture' }));
    const stores = [new Map<string, string>(), new Map([['fixture', JSON.stringify({ access_token: 'invalid-host-fixture' })]])];
    let lateRead = () => readSecretJSON('fixture', legacy);
    let lateWrite = () => writeSecretJSON('fixture', {});
    try {
      expect(() => readSecretJSON('fixture', legacy)).toThrow('host credential store');
      await Promise.all(stores.map((values, i) => withRecipeHost({
        read: key => values.get(key) ?? null,
        write: (key, value) => { values.set(key, value); return true; },
      }, async () => {
        await Promise.resolve();
        expect(readSecretJSON('fixture', legacy)).toEqual(i ? { access_token: 'invalid-host-fixture' } : null);
        writeSecretJSON('fixture', { host: i });
        await Promise.resolve();
        expect(readSecretJSON('fixture', legacy)).toEqual({ host: i });
        lateRead = AsyncResource.bind(() => readSecretJSON('fixture', legacy));
        lateWrite = AsyncResource.bind(() => writeSecretJSON('fixture', {}));
      })));
      expect(lateRead).toThrow('host credential store');
      expect(lateWrite).toThrow('host encrypted store');
      await withRecipeHost({ read: () => '{invalid', write: () => false }, async () => {
        expect(() => readSecretJSON('fixture', legacy)).toThrow();
        expect(() => writeSecretJSON('fixture', {})).toThrow('host encrypted store');
      });
      expect(JSON.parse(await readFile(legacy, 'utf8'))).toEqual({ access_token: 'invalid-legacy-fixture' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

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

  // #6826 output-scope convergence. Real adapter entries, unit tier with
  // fake browser. Earlier tests granted an output callback that Desktop no
  // longer provides; defaults must return links without attempting a save.
  it.each(['gemini/image', 'qwen/image'])('returns %s links without a local export by default', async id => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-default-test-')));
    const url = 'https://example.test/generated.png';
    vi.spyOn(gemini, 'startNewGeminiChat').mockResolvedValue(undefined);
    vi.spyOn(gemini, 'getGeminiVisibleImageUrls').mockResolvedValue([]);
    vi.spyOn(gemini, 'sendGeminiMessage').mockResolvedValue(undefined);
    vi.spyOn(gemini, 'waitForGeminiImages').mockResolvedValue([url]);
    const exportImages = vi.spyOn(gemini, 'exportGeminiImages');
    for (const name of ['ensureOnQianwen', 'dismissLoginModal', 'startNewChat', 'setFeatureToggle'] as const)
      vi.spyOn(qwen, name).mockResolvedValue(undefined);
    vi.spyOn(qwen, 'sendMessage').mockResolvedValue({ ok: true });
    vi.spyOn(qwen, 'hasLoginGate').mockResolvedValue(false);
    vi.spyOn(qwen, 'getMessageBubbles').mockResolvedValue([{ role: 'Assistant', id: 'answer' }]);
    const goto = vi.fn(async () => {});
    const page = { goto, wait: async () => {}, evaluate: async (js: string) =>
      js === 'window.location.href' ? 'https://example.test/' : [url],
    } as unknown as IPage;
    const files = { directory: dir, read: readFileSync, open: (file: string) => openSync(file, 'r') };
    try {
      const result = await executeAdapter(id, { prompt: 'fixture' }, page, undefined, undefined, files);
      expect(JSON.stringify(result)).toContain('https://example.test/');
      expect(exportImages).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
      goto.mockClear();
      await expect(executeAdapter(id, { prompt: 'fixture', sd: false }, page, undefined, undefined, files))
        .rejects.toThrow('Local recipe file export');
      expect(goto).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // A checked metadata path cannot become a write capability. Real shared
  // writer/screenshot, unit tier; valid task paths still reject before writing.
  it('rejects local exports while allowing a content-only web read', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'cindy-recipe-output-test-')));
    const image = path.join(dir, 'image.png');
    const files = { directory: dir, read: readFileSync, open: (file: string) => openSync(file, 'r'), inspect: (file: string) => file };
    const page = { goto: vi.fn(async () => {}), wait: async () => {}, evaluate: async () => ({ title: 'Fixture', contentHtml: '<p>local test text</p>' }) } as unknown as IPage;
    const screenshot = new OpenCliPage({ targetId: 'fixture', call: async request => ({
      ok: true, action: request.action, data: { data: 'aW1hZ2U=' },
    }) });
    try {
      await expect(withRecipeHost(undefined, () => saveBase64ToFile('aW1hZ2U=', image), files))
        .rejects.toThrow('Local recipe file export');
      await expect(withRecipeHost(undefined, () => screenshot.screenshot({ path: image }), files))
        .rejects.toThrow('Local recipe file export');
      const result = await executeAdapter('web/read', { url: 'https://example.test' }, page, undefined, undefined, files);
      expect(JSON.stringify(result)).toContain('local test text');
      await expect(executeAdapter('web/read', { url: 'https://example.test', stdout: false }, page, undefined, undefined, files))
        .rejects.toThrow('Local recipe file export');
      expect(await readdir(dir)).toEqual([]);
    } finally { await screenshot.dispose(); await rm(dir, { recursive: true, force: true }); }
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
      expect(result.message).toContain('File not found');
      expect(call.mock.calls.some(([req]) => req.request?.fn?.includes('atob('))).toBe(false);
      const read = vi.fn(() => Buffer.from('approved-image'));
      const approved = await runRecipe(loadRecipes().get('opencli:yollomi/upload')!, { file }, {
        call, recipeFiles: async () => ({ read, open: file => openSync(file, 'r') }),
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
      for (const id of ['weread-official/book', 'minimax/music', 'jira/search', 'confluence/search']) {
        expect(JSON.stringify(all)).not.toContain(`opencli:${id}`);
        const response = await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'recipe', recipeId: `opencli:${id}` } } });
        expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).ok).toBe(false);
        await expect(executeAdapter(id, {}, {} as IPage)).rejects.toThrow('Unknown bundled adapter');
      }
      for (const id of ['opencli:zlibrary/search', 'opencli:slock/task-create', 'opencli:claude/login', 'opencli:claude/ask', 'opencli:spotify/auth', 'opencli:spotify/status', 'opencli:ones/login', 'opencli:ones/token-info', 'opencli:xiaoyuzhou/history', 'opencli:paperreview/submit', 'opencli:paperreview/review', 'opencli:paperreview/feedback', 'opencli:quark/share-tree', 'opencli:quark/save', 'opencli:kimi/storage-get', 'opencli:kimi/storage-keys', 'opencli:kimi/cookies', 'opencli:kimi/idb-list', 'books-list', 'hockey-search']) {
        expect(JSON.stringify(all)).not.toContain(id);
        const response = await client.callTool({ name: 'call_tool', arguments: { name: 'browser', args: { action: 'recipe', recipeId: id } } });
        expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).ok).toBe(false);
        if (id.startsWith('opencli:')) await expect(executeAdapter(id.slice(8), {}, {} as IPage)).rejects.toThrow('Unknown bundled adapter');
      }
      expect(JSON.stringify(all)).toContain('open-library-search');
      expect(JSON.stringify(all)).toContain('steam-reviews');
      expect(JSON.stringify(all)).toContain('xiaoyuzhou-podcast');
      for (const id of ['instagram/download', 'midjourney/download', 'pixiv/novel-download']) {
        expect(JSON.stringify(all)).not.toContain(`opencli:${id}`);
        await expect(executeAdapter(id, {}, {} as IPage)).rejects.toThrow('Unknown bundled adapter');
      }
      // Discovery and execution share the selected content/link-only defaults.
      for (const [site, command, arg, expected] of [
        ['gemini', 'image', 'sd', true],
        ['qwen', 'image', 'sd', true],
        ['midjourney', 'generate', 'skip-download', true],
        ['web', 'read', 'stdout', true],
      ] as const) {
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
