/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const items = [
  {
    ghostId: 'alpha',
    instanceId: 'alpha',
    title: 'Alpha',
    icon: 'puzzle',
    manifest: { id: 'alpha', name: 'Alpha Plugin' },
    installedGhost: {},
  },
  {
    ghostId: 'workspace',
    instanceId: 'workspace',
    title: 'Workspace',
    icon: 'globe',
    manifest: { id: 'workspace', name: 'Workspace Plugin' },
    installedGhost: {},
  },
];

vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({ declared: items, routeCapable: items, sidebarVisible: items }),
}));
const globalTabsMock = vi.hoisted(() => ({
  addGlobalPluginTab: vi.fn((instanceId: string) => ({ id: `g-${instanceId}`, kind: 'plugin-view', state: { instanceId } })),
  setActiveGlobalTabId: vi.fn(),
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('@/features/right-sidebar/globalTabs', () => ({
  addGlobalPluginTab: globalTabsMock.addGlobalPluginTab,
  setActiveGlobalTabId: globalTabsMock.setActiveGlobalTabId,
}));
vi.mock('@/features/right-sidebar/lib/sidebarCommands', () => ({
  requestRightSidebarVisibility: globalTabsMock.requestRightSidebarVisibility,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      key === 'settings.ghosts.page.manageAria' ? `Manage ${options?.name}` : key,
  }),
}));

import { GhostMainViewNavEntries } from '../GhostMainViewNavEntries';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

describe('GhostMainViewNavEntries', () => {
  it('renders the shared order, active state and encoded navigation', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GhostMainViewNavEntries variant="row" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const alphaButton = screen.getByRole('button', { name: 'Alpha' });
    const workspaceButton = screen.getByRole('button', { name: 'Workspace' });
    expect(alphaButton.getAttribute('aria-current')).toBe('page');
    expect(alphaButton.getAttribute('title')).toBe('Alpha');
    expect(alphaButton.getAttribute('data-native-title')).toBe('truncated-text');
    expect(alphaButton.querySelector('.lucide-puzzle')).toBeTruthy();
    expect(workspaceButton.querySelector('.lucide-globe')).toBeTruthy();
    expect(alphaButton.querySelector('svg')?.getAttribute('width')).toBe('15');
    expect(alphaButton.querySelector('img')).toBeNull();

    fireEvent.click(workspaceButton);
    expect(screen.getByTestId('location').textContent).toBe('/apps/workspace');

    const manageAlphaButton = screen.getByRole('button', { name: 'Manage Alpha Plugin' });
    expect(manageAlphaButton.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(manageAlphaButton);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=alpha');
  });

  // 右键「在侧边栏中打开」= 把该插件视图钉进右侧栏(全局页签)、选中并展开侧栏。
  it('offers "open in the sidebar" from the context menu and pins the plugin view as a global tab', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route path="*" element={<GhostMainViewNavEntries variant="row" />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByText('ghostMainView.openInSidebar'));
    expect(globalTabsMock.addGlobalPluginTab).toHaveBeenCalledWith('workspace');
    expect(globalTabsMock.setActiveGlobalTabId).toHaveBeenCalledWith('g-workspace');
    expect(globalTabsMock.requestRightSidebarVisibility).toHaveBeenCalledWith('open');
  });

  it('uses the native 18px rail icon geometry without a fallback tile', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <GhostMainViewNavEntries variant="rail" />
      </MemoryRouter>,
    );

    const railIcon = screen.getByRole('button', { name: 'Alpha' }).querySelector('svg');
    expect(railIcon?.classList.contains('lucide-puzzle')).toBe(true);
    expect(railIcon?.getAttribute('width')).toBe('18');
  });
});
