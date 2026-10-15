import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CindyProxyMediaServiceOptions } from '../../cindy-proxy-media/types.js';

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  prepareBilling: vi.fn(),
  recordBilling: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => 'https://gateway.example.invalid',
}));
vi.mock('../../cindy-proxy-media/service.js', () => ({
  createCindyProxyMediaService: mocks.createService,
}));
vi.mock('../../cindy-media/generatedMedia.js', () => ({
  createBlobImageStorage: () => ({}),
  createBlobVideoStorage: () => ({}),
}));
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => 'test-key' }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../usage/gatewayMediaBilling.js', () => ({
  prepareGatewayMediaBilling: mocks.prepareBilling,
}));

import { getCindyProxyMediaService, getCindyVideoProviderRegistry } from '../cindyProxyMedia.js';

describe('legacy Gateway media billing wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createService.mockReturnValue({ backend: {} });
    mocks.prepareBilling.mockResolvedValue(mocks.recordBilling);
    mocks.recordBilling.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('wraps JSON and multipart image creation without consuming the response body', async () => {
    getCindyProxyMediaService();
    const opts = mocks.createService.mock.calls[0][0] as CindyProxyMediaServiceOptions;
    const doFetch = opts.imageApi.fetchImplementation!;
    for (const body of [JSON.stringify({ model: 'image-json' }), new FormData()]) {
      if (body instanceof FormData) body.set('model', 'image-multipart');
      const res = Response.json({ data: [] });
      mocks.fetch.mockResolvedValueOnce(res);
      expect(
        await doFetch('https://gateway.example.invalid/v1/images/generations', {
          method: 'POST',
          body,
        }),
      ).toBe(res);
      expect(res.bodyUsed).toBe(false);
    }
    expect(mocks.prepareBilling.mock.calls.map(([input]) => input.model)).toEqual([
      'image-json',
      'image-multipart',
    ]);
    expect(mocks.recordBilling).toHaveBeenCalledTimes(2);
  });

  it('records video create but skips polls and downloads even if they contain billing headers', async () => {
    const { provider } = getCindyVideoProviderRegistry().resolveByAlias('seedance-fast');
    mocks.fetch.mockResolvedValueOnce(Response.json({ id: 'paid-task' }));
    const handle = await provider.submit({ prompt: 'cat' }, 'seedance-fast');
    expect(mocks.recordBilling).toHaveBeenCalledOnce();
    const headers = { 'X-Nova-AIGateway-Billing': Buffer.from('{"cost":1}').toString('base64url') };
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: 'running' }, { headers }));
    await provider.poll(handle);
    mocks.fetch.mockResolvedValueOnce(new Response('video-bytes', { headers }));
    await provider.download('https://cdn.example.invalid/video.mp4');
    expect(mocks.prepareBilling).toHaveBeenCalledOnce();
    expect(mocks.recordBilling).toHaveBeenCalledOnce();
  });
});
