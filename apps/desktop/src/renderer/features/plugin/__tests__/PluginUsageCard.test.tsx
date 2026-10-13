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
it('shows only two personal metrics and clears from the menu after confirmation', async () => {
  const { load, clear } = api();
  const confirm = vi.fn(async () => true);
  render(<PluginUsageCard ghostId="plugin" confirmClear={confirm} />);
  await screen.findByText('7');
  expect(screen.queryByText('Current title')).toBeNull();
  expect(screen.queryByText('settings.ghosts.usage.tasks')).toBeNull();
  expect(screen.queryByText('settings.ghosts.usage.clear')).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.usage.more' }), {
    key: 'Enter',
  });
  await screen.findByRole('menuitem', { name: 'settings.ghosts.usage.clear' });
  fireEvent.click(screen.getByText('settings.ghosts.usage.clear'));
  await waitFor(() => expect(clear).toHaveBeenCalledWith('subject1'));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
it('cancelled confirmation never deletes records', async () => {
  const { clear } = api();
  render(<PluginUsageCard ghostId="plugin" confirmClear={async () => false} />);
  await screen.findByText('7');
  fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.usage.more' }), {
    key: 'Enter',
  });
  await screen.findByRole('menuitem', { name: 'settings.ghosts.usage.clear' });
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
it('hides shared usage and legacy installations when download data is absent', () => {
  const detail = { sourceType: 'server', scope: 'public' } as PluginMarketItem;
  const view = render(<PluginSharedUsage detail={detail} />);
  expect(view.container.childElementCount).toBe(0);
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
  expect(view.container.childElementCount).toBe(0);
  view.rerender(<PluginSharedUsage detail={detail} />);
  expect(view.container.childElementCount).toBe(0);
});
it.each([
  ['git-market', 'public'],
  ['server', 'personal'],
])('hides aggregates outside the authorized scope (%s, %s)', (sourceType, scope) => {
  const detail = {
    sourceType,
    scope,
    downloadStatistics: { requestCount: '12' },
    usageStatistics: {
      installationCount: '12',
      usageCount: '10',
      usageCountLast7Days: '5',
      asOf: '2026-10-12T00:00:00.000Z',
    },
  } as PluginMarketItem;
  const view = render(<PluginSharedUsage detail={detail} />);
  expect(view.container.textContent).toBe('');
});

it('does not expose aggregate calls in the marketplace header', () => {
  const detail = {
    sourceType: 'server',
    scope: 'public',
    usageStatistics: {
      usageCount: '0',
      usageCountLast7Days: '0',
      asOf: '2026-10-12T00:00:00.000Z',
    },
  } as PluginMarketItem;
  const view = render(<PluginSharedUsage detail={detail} />);
  expect(view.container.childElementCount).toBe(0);
  expect(view.container.textContent).not.toContain('installs');
  view.rerender(
    <PluginSharedUsage
      detail={{
        ...detail,
        usageStatistics: {
          usageCountLast7Days: '3',
          asOf: '2026-10-12T00:00:00.000Z',
        },
      }}
    />,
  );
  expect(view.container.childElementCount).toBe(0);
});

it.each(['public', 'organization'] as const)(
  'shows only the cumulative download value in %s without invented installs or usage',
  (scope) => {
    const detail = {
      sourceType: 'server',
      scope,
      downloadStatistics: { requestCount: '123456', last7DaysRequestCount: '12' },
    } as PluginMarketItem;
    const view = render(<PluginSharedUsage detail={detail} />);
    expect(screen.getByText('settings.ghosts.usage.downloads 123,456')).toBeTruthy();
    expect(view.container.textContent).not.toContain('installs');
    expect(view.container.textContent).not.toContain('uses');
    expect(view.container.textContent).not.toContain('last7Days');
    view.rerender(
      <PluginSharedUsage detail={{ ...detail, downloadStatistics: { requestCount: '0' } }} />,
    );
    expect(screen.getByText('settings.ghosts.usage.downloads 0')).toBeTruthy();
    view.rerender(
      <PluginSharedUsage
        detail={{ ...detail, downloadStatistics: { requestCount: '18446744073709551615' } }}
      />,
    );
    expect(
      screen.getByText('settings.ghosts.usage.downloads 18,446,744,073,709,551,615'),
    ).toBeTruthy();
  },
);
