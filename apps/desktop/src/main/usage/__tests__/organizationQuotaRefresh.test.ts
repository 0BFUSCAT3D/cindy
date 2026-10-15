import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { mode: 'cloud', dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } },
  managed: vi.fn(), outbound: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../authManager', () => ({ getAuthState: () => mocks.auth }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: mocks.broadcast }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../maker-host/auth-adapters', () => ({ readClaudeApiKey: () => 'fixture-key' }));
vi.mock('../../maker-host/outbound-fetch', () => ({ outboundFetch: mocks.outbound }));
vi.mock('../../maker-host/runtime-configs', () => ({ claudeUpstreamEndpoint: () => 'https://gateway.example.test' }));
vi.mock('../modelPricing', () => ({ getGatewayAccountCurrency: async () => 'CNY' }));
vi.mock('../ledgerCurrency', () => ({ currentLedgerCurrency: () => 'CNY' }));
vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: mocks.managed }));
const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  mocks.auth = { mode: 'cloud', dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } };
  mocks.managed.mockResolvedValue(quota);
  mocks.outbound.mockResolvedValue({ ok: true, json: async () => ({ spend: 2, max_budget: 20, results: [] }) });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('Cindy AI enterprise quota refresh', () => {
  it('publishes server quota without calling LiteLLM APIs on an inference gateway', async () => {
    const api = await import('../claudeAccountUsage');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('preserves legacy Nova quota reads when the server capability is unsupported', async () => {
    mocks.managed.mockResolvedValue(undefined);
    const api = await import('../claudeAccountUsage');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toMatchObject({ spend: 2, maxBudget: 20 });
    expect(mocks.outbound).toHaveBeenCalledTimes(2);
  });
  it('does not query legacy credentials on managed-query errors', async () => {
    mocks.managed.mockResolvedValue(null);
    const api = await import('../claudeAccountUsage');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('drops an in-flight response when switching enterprise accounts', async () => {
    let resolve!: (value: unknown) => void;
    mocks.managed.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const api = await import('../claudeAccountUsage');
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    mocks.auth = { ...mocks.auth, dataOwnerId: 'owner-b' };
    resolve(quota); await pending;
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
  });
  it('clears and broadcasts an unlimited result after a finite quota was cached', async () => {
    const api = await import('../claudeAccountUsage');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
    mocks.managed.mockResolvedValue('unlimited');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'unlimited' });
    mocks.managed.mockResolvedValue(null);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'unlimited' });
    mocks.auth = { ...mocks.auth, dataOwnerId: 'other-owner' };
    expect(api.readClaudeAccountQuotaClear()).toBeNull();
    expect(mocks.broadcast).toHaveBeenLastCalledWith('usage:claude-account-changed', null);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('keeps local gateway reads on the original endpoint', async () => {
    mocks.auth.mode = 'local';
    const api = await import('../claudeAccountUsage');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.outbound).toHaveBeenCalledTimes(2);
  });
});
