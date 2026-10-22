/** Integration: real Codex, isolated home and scripted loopback provider; no credentials.
 * Regression: a global target budget hid the previous model's larger window.
 * CINDY_CODEX_TEST_BINARY=<absolute path> vitest run <this file>
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger';
import { nativeCodexFallbackModel, prepareCodexCustomContextCatalog } from '../codex-custom-context-catalog';

const binary = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

it.skipIf(!binary)('cold-resumes the same history, compacts with the larger model, then sends to the smaller model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-context-switch-native-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const windows: Record<string, number> = { 'codex/fixture-wide': 500_000, 'fixture-small': 272_000 };
  const requests: Array<{ model: string; input: unknown[] }> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.end('{"models":[]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const text = requests.length === 1 ? 'FIRST_REPLY' : requests.length === 2 ? 'NATIVE_SUMMARY' : 'CONTINUED';
    const inputTokens = requests.length === 1 ? 300_000 : 20;
    const item = { type: 'message', role: 'assistant', id: `msg-${requests.length}`,
      content: [{ type: 'output_text', text, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `r-${requests.length}` } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `r-${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  let agent: CodexAgent | undefined;
  try {
    await fs.mkdir(home); await fs.mkdir(work);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: Object.keys(windows)
      .map(slug => nativeCodexFallbackModel(slug.replace(/^codex\//, ''), 'You are a test assistant.')) }));
    await fs.writeFile(path.join(home, 'config.toml'), [
      'model_provider="fixture"', 'cli_auth_credentials_store="ephemeral"',
      'check_for_update_on_startup=false', '[analytics]', 'enabled=false',
      '[model_providers.fixture]', 'name="Fixture"',
      `base_url="http://127.0.0.1:${(server.address() as AddressInfo).port}"`,
      'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0',
      '[mcp_servers.cindy_memory]', 'url="http://127.0.0.1:1/mcp"', 'enabled=false',
    ].join('\n'));
    const makeAgent = () => new CodexAgent({
      binaryPath: binary!, logger, runtimeConfig: {}, resolveCodexLocalAuthPolicy: () => 'isolated',
      resolveCodexThreadContextWindow: (_provider, model) => windows[model] ?? null,
      prepareCodexExtraSpawnConfig: async (_providers, ctx) => {
        expect(ctx.customContextProviderId).toBe('cprov-fixture');
        const catalog = await prepareCodexCustomContextCatalog({ binaryPath: binary!, codexHome: home,
          modelId: ctx.customContextModel!, contextWindow: ctx.customContextWindow!,
          modelIds: Object.keys(windows),
          resolveContextWindow: model => windows[model] ?? null });
        return { extraArgs: catalog.extraArgs, extraEnv: {}, codexProxyActive: true };
      },
      auth: {
        getState: async () => ({ authenticated: true }), triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {}, getAuthEnv: async () => ({
          HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, CODEX_HOME: home, TMPDIR: root,
          OPENAI_API_KEY: '', CODEX_API_KEY: '', HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    agent = makeAgent();
    const options = { sessionId: 'context-switch', providerId: 'cprov-fixture', workingDir: work, makerMemoryEnabled: false };
    let handle = await agent.startSession({ ...options, model: 'codex/fixture-wide' });
    const send = async (text: string) => {
      const finished = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
        throw new Error('Native turn ended without completion');
      })();
      await handle.send({ type: 'user', content: text }, { throwOnStartFailure: true });
      await finished;
    };
    await send('ORIGINAL_HISTORY_MARKER');
    const threadId = handle.id;
    expect(requests).toHaveLength(1);
    expect(handle.getUsageSnapshot().contextWindow).toBe(475_000);
    await handle.close(); await agent.dispose();
    agent = makeAgent();
    handle = await agent.startSession({ ...options, model: 'fixture-small', resumeSessionId: threadId });
    expect(handle.id).toBe(threadId);
    await send('CONTINUE_MARKER');
    expect(requests.map(request => request.model)).toEqual(['codex/fixture-wide', 'codex/fixture-wide', 'fixture-small']);
    expect(JSON.stringify(requests[1]!.input)).toContain('ORIGINAL_HISTORY_MARKER');
    expect(JSON.stringify(requests[1]!.input)).toContain('FIRST_REPLY');
    expect(JSON.stringify(requests[2]!.input)).toContain('NATIVE_SUMMARY');
    expect(JSON.stringify(requests[2]!.input)).toContain('CONTINUE_MARKER');
    expect(handle.getUsageSnapshot().contextWindow).toBe(258_400);
    await handle.close();
  } finally {
    await agent?.dispose();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
