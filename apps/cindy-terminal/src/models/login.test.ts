import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteResourceRegistry } from '@cindy/device-link';
import { TerminalSecretStore } from '../secrets.js';
import { TerminalModelConfig } from './config.js';
import { TerminalProviderLogin, type ProviderLoginState } from './login.js';
import { TerminalConfiguration } from '../configuration.js';
import { TerminalCapabilities } from '../tasks/capabilities.js';
import { TerminalProtectedInput } from '../protected-input.js';
import { registerModelConfigurationResources } from './resources.js';
import { createProviderProxy } from './proxy.js';
import * as platform from '../platform.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Integration: headless provider login must survive another computer's browser
// callback without putting the code/token on the generic remote wire. Use the
// actual controller cryptography, PKCE, encrypted vault and request proxy.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-provider-login-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const secrets = new TerminalSecretStore(root);
  await secrets.initialize('machine');
  const requests: Array<{
    path: string;
    body: string;
    authorization?: string;
  }> = [];
  let beforeToken: (() => Promise<void>) | undefined;
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url!,
      body,
      authorization: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      await beforeToken?.();
      res.end(
        JSON.stringify({
          access_token: body.includes('grant_type=refresh_token')
            ? 'synthetic-refreshed-token'
            : 'synthetic-private-access',
          refresh_token: 'synthetic-private-refresh',
          expires_in: 3600,
        }),
      );
    } else if (req.url === '/chat/completions')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'OAUTH_ROUTE_OK' } }],
        }),
      );
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  const endpoint = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  let active = true;
  const guard = () => {
    if (!active) throw new Error('OWNER_CHANGED');
  };
  const models = new TerminalModelConfig(root, secrets, async () => ({
    authenticated: false,
  }));
  await models.open();
  await models.saveProvider(
    {
      id: 'fixture',
      name: 'Fixture OAuth',
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://idp.example/authorize',
          tokenUrl: 'https://idp.example/token',
          clientId: 'public-fixture',
          scopes: 'inference offline_access',
        },
      },
      runtimes: {
        codex: {
          baseUrl: endpoint,
          wireProtocol: 'openai-chat',
          models: [{ id: 'fixture-model', name: 'Fixture' }],
        },
      },
    },
    {},
    true,
  );
  const login = new TerminalProviderLogin({
    models,
    secrets,
    assertCurrent: guard,
    changed: () => models.gatewayChanged(),
    log: { info() {}, warn() {} },
    fetch: (url, init) => {
      if (String(url) !== 'https://idp.example/token')
        throw new Error('UNEXPECTED_FIXTURE_REQUEST');
      return fetch(endpoint + '/token', init);
    },
  });
  cleanup.push(() => login.close());
  const capabilities = new TerminalCapabilities({
    root,
    secrets,
    assertCurrent: guard,
    changed() {},
    workingDirs: async () => [root],
  });
  const configuration = new TerminalConfiguration(capabilities, {
    login,
    revision: () => models.revision(),
    save: (action, config, keys, context) =>
      models.saveProvider(
        config,
        keys,
        action === 'create',
        context.assertCurrent,
      ),
  });
  const registry = new RemoteResourceRegistry();
  registerModelConfigurationResources(
    registry,
    models,
    configuration,
    async () => {
      throw new Error('UNEXPECTED_MUTATION');
    },
  );
  const wire: unknown[] = [],
    events: unknown[] = [];
  const make = (deviceId: string): TerminalProtectedInput =>
    new TerminalProtectedInput({
      root: path.join(root, deviceId),
      secrets,
      scope: () => ({ realm: 'global', membershipId: 'owner', deviceId }),
      assertCurrent: guard,
      remoteEnabled: () => true,
      taskExists: async () => true,
      emit: (channel, payload) => events.push({ channel, payload }),
      invoke: async (_device, channel, args) => {
        wire.push({ channel, args });
        const result =
          channel === 'maker:remote-resources:invoke'
            ? await registry.invoke(
                { controllerDeviceId: deviceId, assertCurrent: guard },
                args[0] as Parameters<typeof registry.invoke>[1],
              )
            : await host.request(deviceId, args[0]);
        wire.push({ result });
        return { ok: true, result };
      },
    });
  const host = make('host'),
    controller = make('controller');
  host.configureSettings(configuration);
  cleanup.push(async () => {
    active = true;
    await controller.close();
    await host.close();
  });
  async function begin() {
    const { id } = await controller.channelRegistration(
      { command: 'begin', providerId: 'fixture', deviceId: 'host' },
      'providers',
    );
    let state: ProviderLoginState = { status: 'pending' };
    await vi.waitFor(
      async () => {
        state = (
          await controller.channelRegistration(
            { command: 'read', id },
            'providers',
          )
        ).state!;
        expect(state.verificationUrl).toBeTruthy();
      },
      { interval: 5 },
    );
    const url = new URL(state.verificationUrl!);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'synthetic-private-code');
    return { id, url, callback };
  }
  return {
    root,
    secrets,
    login,
    models,
    controller,
    wire,
    events,
    requests,
    begin,
    revoke: () => {
      active = false;
    },
    intercept: (fn: () => Promise<void>) => {
      beforeToken = fn;
    },
  };
}

it('seals callback input, validates PKCE, refreshes the live proxy and disconnects without leaking credentials', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = await fixture(),
    { id, url, callback } = await f.begin();
  const invalid = new URL(callback);
  invalid.searchParams.set('state', 'wrong-state');
  await expect(
    f.controller.channelRegistration(
      { command: 'submit', id, callback: invalid.href },
      'providers',
    ),
  ).rejects.toThrow('REGISTRATION_FAILED');
  expect(f.login.connected('fixture')).toBe(false);
  await f.controller.channelRegistration(
    { command: 'submit', id, callback: callback.href },
    'providers',
  );
  await vi.waitFor(
    async () =>
      expect(
        (
          await f.controller.channelRegistration(
            { command: 'read', id },
            'providers',
          )
        ).state?.status,
      ).toBe('success'),
    { interval: 5 },
  );
  const tokenRequest = new URLSearchParams(f.requests[0].body);
  expect(
    createHash('sha256')
      .update(tokenRequest.get('code_verifier')!)
      .digest('base64url'),
  ).toBe(url.searchParams.get('code_challenge'));
  expect(tokenRequest.get('code')).toBe('synthetic-private-code');
  expect(tokenRequest.get('redirect_uri')).toBe(
    url.searchParams.get('redirect_uri'),
  );
  const chosen = await f.models.select({
    providerId: 'fixture',
    agentKind: 'codex',
    model: 'fixture-model',
  });
  const bound = await createProviderProxy(
    chosen.route,
    'codex',
    await f.models.credential('fixture', 'codex'),
    {},
    undefined,
    undefined,
    () => f.models.credential('fixture', 'codex'),
  );
  cleanup.push(() => bound.close());
  const request = async () =>
    fetch(bound.url + '/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bound.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'fixture-model',
        input: 'probe',
        stream: false,
      }),
    });
  expect((await request()).status).toBe(200);
  expect(f.requests.at(-1)?.authorization).toBe(
    'Bearer synthetic-private-access',
  );
  vi.setSystemTime(Date.now() + 3600_000);
  expect((await request()).status).toBe(200);
  expect(f.requests.at(-1)?.authorization).toBe(
    'Bearer synthetic-refreshed-token',
  );
  const reopened = new TerminalSecretStore(f.root);
  await reopened.open();
  expect(await reopened.get('terminal:provider-oauth:fixture')).toContain(
    'synthetic-refreshed-token',
  );
  const saved = f.models.snapshot().providers[0];
  const failedSave = vi
    .spyOn(platform, 'atomicPrivateWrite')
    .mockRejectedValueOnce(new Error('EIO'));
  await expect(
    f.models.saveProvider({ ...saved, auth: { method: 'none' } }, {}, false),
  ).rejects.toThrow('EIO');
  failedSave.mockRestore();
  expect(await f.models.credential('fixture', 'codex')).toBe(
    'synthetic-refreshed-token',
  );
  expect(f.models.snapshot().providers[0].auth?.method).toBe('oauth');
  for (const secret of [
    'synthetic-private-code',
    'synthetic-private-access',
    'synthetic-private-refresh',
    'synthetic-refreshed-token',
  ]) {
    expect(
      JSON.stringify({
        wire: f.wire,
        events: f.events,
        views: await f.models.views(),
      }),
    ).not.toContain(secret);
    expect(
      await readFile(path.join(f.root, 'secrets.enc'), 'utf8'),
    ).not.toContain(secret);
    expect(
      await readFile(path.join(f.root, 'models.json'), 'utf8'),
    ).not.toContain(secret);
  }
  f.login.disconnect('fixture');
  expect((await request()).status).toBe(403);
  expect(f.login.connected('fixture')).toBe(false);
});

it('discards a token response that arrives after the owner is revoked', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.intercept(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const { id, callback } = await f.begin();
  await f.controller.channelRegistration(
    { command: 'submit', id, callback: callback.href },
    'providers',
  );
  await started;
  f.revoke();
  release();
  await f.login.close();
  expect(await f.secrets.get('terminal:provider-oauth:fixture')).toBeNull();
  await expect(
    f.controller.channelRegistration({ command: 'read', id }, 'providers'),
  ).rejects.toThrow('OWNER_CHANGED');
});
