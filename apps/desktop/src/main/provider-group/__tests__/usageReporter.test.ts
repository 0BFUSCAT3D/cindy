/**
 * 向组所在电脑报告经它的组、在组里别的电脑上运行的用量(provider-groups.md §7)：启动后整份报一次，
 * 记账后防抖报从那天起的一份；送不到退避重报，旧版本隔得更久再试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupRemoteUsageRow } from '../../../shared/providerGroup';
import { ProviderGroupRemoteUnsupportedError } from '../remoteClient';
import {
  createProviderGroupUsageReporter,
  fitUsageReport,
  PROVIDER_GROUP_USAGE_DEBOUNCE_MS,
  PROVIDER_GROUP_USAGE_RETRY_MIN_MS,
  PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS,
  PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS,
} from '../usageReporter';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const row = (day: string, input = 1): ProviderGroupRemoteUsageRow => ({
  day, providerId: 'anthropic', memberKey: 'device:studio:a', kind: 'claude-code', model: 'opus',
  turns: 1, inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
});

function setup(owners: string[] = []) {
  const ledger: Record<string, ProviderGroupRemoteUsageRow[]> = { mini: [row('2026-10-10'), row('2026-10-11')] };
  const send = vi.fn(async (_owner: string, _report: { seq: number; sinceDay: string | null; rows: ProviderGroupRemoteUsageRow[] }) => undefined);
  const warn = vi.fn();
  const reporter = createProviderGroupUsageReporter({
    owners: () => owners,
    rows: (owner, sinceDay) => (ledger[owner] ?? []).filter((item) => !sinceDay || item.day >= sinceDay),
    send,
    now: () => Date.now(),
    log: { warn },
  });
  return { reporter, send, warn, ledger };
}

describe('provider group usage reporter', () => {
  it('reports everything once after start, then the days that changed after a short debounce', async () => {
    const { reporter, send } = setup(['mini']);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ sinceDay: null, rows: [row('2026-10-10'), row('2026-10-11')] });

    reporter.notify('mini', '2026-10-11');
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ sinceDay: '2026-10-11', rows: [row('2026-10-11')] });
    // 序号只增。
    expect(send.mock.calls[1]![1].seq).toBeGreaterThan(send.mock.calls[0]![1].seq);
    reporter.dispose();
  });

  it('retries with backoff when the report does not get through, keeping the earliest day', async () => {
    const { reporter, send, warn } = setup();
    send.mockRejectedValueOnce(new Error('[REMOTE_AGENT_UNAVAILABLE] offline'));
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // 等重试期间又记了更早一天的(跨午夜)：到点一起报，不提前。
    reporter.notify('mini', '2026-10-10');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_RETRY_MIN_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ sinceDay: '2026-10-10' });
    reporter.dispose();
  });

  it('waits much longer before trying an older group computer again', async () => {
    const { reporter, send } = setup();
    send.mockRejectedValueOnce(new ProviderGroupRemoteUnsupportedError());
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_UNSUPPORTED_RETRY_MS - 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });

  it('sends what changed during a report right after it', async () => {
    const { reporter, send } = setup();
    let finish!: () => void;
    send.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finish = () => resolve(undefined);
    }));
    reporter.notify('mini', '2026-10-11');
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    reporter.notify('mini', '2026-10-11');
    finish();
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.dispose();
  });
});

describe('fitUsageReport', () => {
  it('keeps whole days from the newest when there are too many rows', () => {
    const rows = [row('2026-10-09'), row('2026-10-10'), row('2026-10-10', 2), row('2026-10-11')];
    expect(fitUsageReport(rows, null, 10)).toEqual({ sinceDay: null, rows });
    const fitted = fitUsageReport(rows, null, 3);
    expect(fitted.sinceDay).toBe('2026-10-10');
    expect(fitted.rows.map((item) => item.day).sort()).toEqual(['2026-10-10', '2026-10-10', '2026-10-11']);
  });
});
