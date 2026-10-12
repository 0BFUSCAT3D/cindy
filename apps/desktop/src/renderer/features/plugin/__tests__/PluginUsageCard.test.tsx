// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginUsageCard } from '../PluginUsageCard';
import { PluginSharedUsage } from '../PluginSharedUsage';
import type { PluginUsageSummary } from '../../../../shared/pluginUsage';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
afterEach(cleanup);
const summary: PluginUsageSummary = {
  subjectId: 'subject1',
  recordingStartedAt: 1,
  lastUsedAt: 2,
  callsLast7Days: 7,
  totalCalls: 8,
  until: 3,
  deviceName: 'Mac',
  recentTasks: [{ sessionId: 'task1', title: 'Current title', lastUsedAt: 2 }],
};
function api(load = vi.fn(async () => summary)) {
  const clear = vi.fn(async () => {});
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { ghosts: { usageSummary: load, clearUsage: clear } },
  });
  return { load, clear };
}
it('opens original task and clears only after confirmation, then re-reads host records', async () => {
  const { load, clear } = api();
  const open = vi.fn();
  const confirm = vi.fn(async () => true);
  render(<PluginUsageCard ghostId="plugin" onOpenTask={open} confirmClear={confirm} />);
  fireEvent.click(await screen.findByText('Current title'));
  expect(open).toHaveBeenCalledWith('task1');
  fireEvent.click(screen.getByText('settings.ghosts.usage.clear'));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('subject1'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
it('cancelled confirmation never deletes records', async () => {
  const { clear } = api();
  render(<PluginUsageCard ghostId="plugin" confirmClear={async () => false} />);
  await screen.findByText('Current title');
  fireEvent.click(screen.getByText('settings.ghosts.usage.clear'));
  await Promise.resolve();
  expect(clear).not.toHaveBeenCalled();
});
it('distinguishes unavailable from actual zero with no invented usage', async () => {
  api(vi.fn().mockRejectedValue(new Error('unavailable')));
  const view = render(<PluginUsageCard ghostId="plugin" />);
  await screen.findByText('settings.ghosts.usage.unavailable');
  expect(screen.queryByText('0')).toBeNull();
  view.unmount();
  api(
    vi.fn(async () => ({
      ...summary,
      lastUsedAt: null,
      callsLast7Days: 0,
      totalCalls: 0,
      recentTasks: [],
    })),
  );
  render(<PluginUsageCard ghostId="plugin" />);
  await screen.findByText('settings.ghosts.usage.never');
  expect(screen.getByText('0')).toBeTruthy();
});
it('only shows authorized server aggregates and keeps missing fields distinct from zero', () => {
  const detail = { sourceType: 'server', scope: 'public' } as PluginMarketItem;
  const view = render(<PluginSharedUsage detail={detail} />);
  expect(screen.getAllByText(/sharedUnavailable/)).toHaveLength(2);
  view.rerender(
    <PluginSharedUsage
      detail={{
        ...detail,
        usageStatistics: {
          installationCount: '0',
          usageCount: '10',
          usageCountLast7Days: '5',
          asOf: '2026-10-12T00:00:00.000Z',
        },
      }}
    />,
  );
  expect(screen.getByText('settings.ghosts.usage.installs 0')).toBeTruthy();
  view.rerender(<PluginSharedUsage detail={{ ...detail, sourceType: 'git-market' }} />);
  expect(view.container.textContent).toBe('');
});
