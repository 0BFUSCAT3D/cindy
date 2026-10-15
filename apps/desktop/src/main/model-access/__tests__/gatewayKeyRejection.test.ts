/**
 * gatewayKeyRejection 单测:Cindy AI Key 被网关 401 后的统一上报入口(依赖全注入)。
 * 覆盖:各「直接跳过」条件、规则 A(只认当前 Key)、规则 B(每把 Key 只触发一次)、
 * sync 失败不外冒、单例安装/卸载,以及 fetch 包装从 Authorization 头取 Key。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bearerKeyFromHeaders,
  createGatewayKeyRejectionReporter,
  installCindyGatewayKeyRejectionReporter,
  reportCindyGatewayKeyRejected,
  withCindyGatewayKeyRejectionReport,
  type GatewayKeyRejectionDeps,
} from '../gatewayKeyRejection.js';

const KEY_A = 'sk-test-invalid-a';
const KEY_B = 'sk-test-invalid-b';

function harness(overrides: Partial<GatewayKeyRejectionDeps> = {}) {
  let currentKey: string | null = KEY_A;
  const requestSync = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: GatewayKeyRejectionDeps = {
    canUseCindyGateway: () => true,
    isSessionBoundaryPending: () => false,
    getCredentialSource: () => 'server',
    readCurrentKey: () => currentKey,
    requestSync,
    log,
    ...overrides,
  };
  return {
    report: createGatewayKeyRejectionReporter(deps),
    requestSync: (overrides.requestSync as typeof requestSync | undefined) ?? requestSync,
    log,
    setCurrentKey: (key: string | null) => {
      currentKey = key;
    },
  };
}

describe('createGatewayKeyRejectionReporter', () => {
  it('re-syncs once when the current server-issued key is rejected', () => {
    const h = harness();
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    expect(h.log.info).toHaveBeenCalledWith('Cindy AI key rejected by gateway, re-syncing credentials');
    // 日志不得带 Key 本身。
    for (const call of [...h.log.info.mock.calls, ...h.log.warn.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(KEY_A);
    }
  });

  it.each([
    ['gateway capability is unavailable', { canUseCindyGateway: () => false }],
    ['an account switch is pending', { isSessionBoundaryPending: () => true }],
    ['the key was entered manually', { getCredentialSource: () => 'manual' as const }],
    ['the key has no source marker', { getCredentialSource: () => null }],
  ])('skips when %s', (_label, overrides) => {
    const h = harness(overrides);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ''])('skips an empty used key (%s)', (usedKey) => {
    const h = harness();
    h.report(usedKey);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it('ignores a rejection for a key that is no longer the stored key (rule A)', () => {
    const h = harness();
    h.setCurrentKey(KEY_B);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
    h.setCurrentKey(null);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it('triggers once per key and again after the key changes (rule B)', () => {
    const h = harness();
    h.report(KEY_A);
    h.report(KEY_A);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);

    h.setCurrentKey(KEY_B);
    h.report(KEY_B);
    h.report(KEY_B);
    expect(h.requestSync).toHaveBeenCalledTimes(2);

    // 换回旧 Key 时与「上一次」不同,允许再触发。
    h.setCurrentKey(KEY_A);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(3);
  });

  it('does not remember a key whose report was skipped', () => {
    let pending = true;
    const h = harness({ isSessionBoundaryPending: () => pending });
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
    pending = false;
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected sync', async () => {
    const requestSync = vi.fn(async () => {
      throw new Error('network down');
    });
    const h = harness({ requestSync });
    expect(() => h.report(KEY_A)).not.toThrow();
    await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalledTimes(1));
  });

  it('swallows a synchronously throwing dependency', () => {
    const h = harness({
      requestSync: () => {
        throw new Error('sync unavailable');
      },
      readCurrentKey: () => KEY_A,
    });
    expect(() => h.report(KEY_A)).not.toThrow();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('reportCindyGatewayKeyRejected singleton', () => {
  afterEach(() => installCindyGatewayKeyRejectionReporter(null));

  it('is a no-op before model-access installs a reporter', () => {
    expect(() => reportCindyGatewayKeyRejected(KEY_A)).not.toThrow();
  });

  it('delegates to the installed reporter', () => {
    const reporter = vi.fn();
    installCindyGatewayKeyRejectionReporter(reporter);
    reportCindyGatewayKeyRejected(KEY_A);
    expect(reporter).toHaveBeenCalledWith(KEY_A);
  });
});

describe('bearerKeyFromHeaders', () => {
  it('reads bearer keys from every HeadersInit shape', () => {
    expect(bearerKeyFromHeaders({ Authorization: `Bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerKeyFromHeaders({ authorization: `bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerKeyFromHeaders(new Headers({ Authorization: `Bearer ${KEY_A}` }))).toBe(KEY_A);
    expect(bearerKeyFromHeaders([['Authorization', `Bearer ${KEY_A}`]])).toBe(KEY_A);
  });

  it('returns null without a bearer authorization header', () => {
    expect(bearerKeyFromHeaders(undefined)).toBeNull();
    expect(bearerKeyFromHeaders({ 'x-api-key': KEY_A })).toBeNull();
    expect(bearerKeyFromHeaders({ Authorization: `Basic ${KEY_A}` })).toBeNull();
    expect(bearerKeyFromHeaders({ Authorization: 'Bearer ' })).toBeNull();
  });
});

describe('withCindyGatewayKeyRejectionReport', () => {
  it('reports the bearer key of a 401 request and returns the response untouched', async () => {
    const response = new Response('denied', { status: 401 });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);

    const result = await wrapped('https://gateway.invalid/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });

    expect(result).toBe(response);
    expect(report).toHaveBeenCalledWith(KEY_A);
    expect(fetchImpl).toHaveBeenCalledWith('https://gateway.invalid/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
  });

  it('reads the key from a Request object', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await wrapped(new Request('https://gateway.invalid/v1/embeddings', {
      headers: { Authorization: `Bearer ${KEY_B}` },
    }));
    expect(report).toHaveBeenCalledWith(KEY_B);
  });

  it.each([200, 403, 500])('does not report HTTP %s', async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await wrapped('https://gateway.invalid/v1/embeddings', {
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('propagates network failures without reporting', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await expect(wrapped('https://gateway.invalid/v1/embeddings')).rejects.toThrow('fetch failed');
    expect(report).not.toHaveBeenCalled();
  });
});
