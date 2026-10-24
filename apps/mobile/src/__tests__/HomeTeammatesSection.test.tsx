// @vitest-environment jsdom
import { act, createContext, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ cloudRefresh: vi.fn(async () => {}), push: vi.fn(),
  cloudActor: null as null | { id: string }, createOptions: null as any }));
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  ScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, disabled, onPress }: any) => el('button', { 'data-testid': testID, disabled, onClick: onPress }, children),
  ActivityIndicator: () => el('i', { 'data-testid': 'spinner' }),
  Keyboard: { dismiss: () => {} },
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
}));
vi.mock('expo-router/react-navigation', () => ({
  NavigationContext: createContext(null), NavigationRouteContext: createContext(null), useIsFocused: () => true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Plus: () => null, RefreshCw: () => null, UsersRound: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/chat/cloudCompanion', () => ({ CLOUD_ROW_REVISION: 'cloud', cloudActorForRow: () => h.cloudActor, cloudCompanionRows: (items: unknown) => items }));
vi.mock('@/session/teammateNavigation', () => ({ cloudCompanionRoute: () => '/cloud-chat' }));
vi.mock('@/session/botGroupNavigation', () => ({ botGroupRoute: () => '/group-chat' }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => ({ supported: true, actors: [], deviceNames: {}, refresh: h.cloudRefresh }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ isRemoteResourceUnread: () => false, remoteResourceCacheRevision: () => 0, subscribeRemoteResourceCache: () => () => {} }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = tokens.lightColors;
  return { ...tokens, useThemedStyles: (factory: (value: typeof colors) => unknown) => factory(colors), useTheme: () => ({ colors }) };
});
vi.mock('@/session/BotGroupAvatars', () => ({ BotGroupDuoAvatar: () => null, useBotGroupIdentities: () => () => ({}) }));
vi.mock('@/session/BotGroupList', () => ({ OFFLINE_AVATAR_OPACITY: 0.45 }));
vi.mock('@/session/CompanionListRow', () => ({ COMPANION_ROW_AVATAR_SIZE: 44, COMPANION_ROW_DOT_SIZE: 10 }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/HomeRosterContext', () => ({ useHomeRoster: () => null }));
vi.mock('@/session/HomeListVisuals', () => ({ homeListStyles: () => ({}) }));
vi.mock('@/session/listDisclosureTransition', () => ({ DisclosureItem: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children) }));
vi.mock('@/session/TeammateCreateController', () => ({ useTeammateCreateController: (options: any) => {
  h.createOptions = options;
  return { renderTrigger: (trigger: unknown) => trigger, press: () => {}, label: 'create', sheets: null };
} }));
vi.mock('@/session/TeammateList', () => ({
  useTeammateEntries: (items: any[], groups: any[] = []) => [...items.map(row => ({ kind: 'bot', row })), ...groups.map(row => ({ kind: 'group', row }))],
  useTeammateRowRenderer: (options: any) => (entry: any) => el('button', { key: entry.row.key,
    'data-testid': `row.${entry.kind}`, onClick: () => entry.kind === 'bot' ? options.onSelect(entry.row) : options.groups.onSelect(entry.row) }, entry.row.item.display.title),
}));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({
  owner: 'owner', teammatesCollapsed: false, lastTeammate: null,
  setTeammatesCollapsed: async () => {}, openTeammate: async () => {}, openCreatedTeammate: async () => {} }) }));
import { HomeTeammatesSection } from '../session/HomeTeammatesSection';

const item = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Mac' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [], display: { title: 'Mimi' } } };
const roster = { items: [item], createTargets: [], groupTargets: [], loading: false, refreshing: false, error: 'LIST_FAILED' as string | null,
  isOnline: () => true, connectionState: undefined, refresh: vi.fn(async () => {}) };
const groups = { items: [], supported: true, refreshing: false, error: null, isOnline: () => true, refresh: vi.fn(async () => {}) };
let root: Root; let node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); root = createRoot(node); vi.clearAllMocks(); h.cloudActor = null; });
afterEach(async () => { await act(async () => root.unmount()); });
const render = (refreshKey: number, overrides: Partial<Parameters<typeof HomeTeammatesSection>[0]> = {}) => act(async () => root.render(el(HomeTeammatesSection, {
  context: { navigation: null, route: null, shared: { roster, groups } } as any, active: true, refreshKey,
  visible: true, query: '', showFooter: false, runDisclosure: (apply: () => void) => apply(), prepareDisclosure: () => {},
  ...overrides,
})));
const byId = (id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// The retired teammate page showed read failures with a retry; the home section must not lose them.
it('keeps cached teammates, names a failed read and retries every teammate source', async () => {
  await render(0);
  expect(node.textContent).toContain('Mimi');
  expect(byId('home.teammatesError')?.textContent).toBe('devices.companions.stale');
  h.cloudRefresh.mockClear();
  await act(async () => byId('home.teammatesRetry')!.click());
  expect(roster.refresh).toHaveBeenCalledTimes(1);
  expect(groups.refresh).toHaveBeenCalledTimes(1);
  expect(h.cloudRefresh).toHaveBeenCalledTimes(1);
});

// Pull-to-refresh lives on the home list; it reaches the section's cloud companions through the key.
it('re-reads cloud companions on each manual home refresh', async () => {
  await render(0);
  h.cloudRefresh.mockClear();
  await render(1);
  expect(h.cloudRefresh).toHaveBeenCalledTimes(1);
});

// PR #7079: unit-tier component coverage of the cloud/group routes that bypass the teammate hook.
// Existing coverage only refreshed the roster. A deferred host push must prevent navigation until
// drawer close; the creation receipt is a separate entry after its own sheet has already closed.
it.each(['cloud', 'group', 'created-group'] as const)('defers the %s route until the drawer closes', async kind => {
  let routeAfterClose: (() => void) | undefined;
  const bot = { ...item, item: { ...item.item, revision: 'cloud' } };
  const group = { ...item, key: 'host:group', item: { ...item.item, ref: { ...item.item.ref, id: 'group' } } };
  h.cloudActor = { id: 'actor' };
  await render(0, { push: href => { routeAfterClose = () => h.push(href); },
    context: { navigation: null, route: null, shared: { roster: { ...roster, items: [bot] }, groups: { ...groups, items: [group] } } } as any });
  await act(async () => {
    if (kind === 'created-group') h.createOptions.onGroupCreated(item.host, 'group');
    else byId(`row.${kind === 'cloud' ? 'bot' : 'group'}`)!.click();
  });
  expect(h.push).not.toHaveBeenCalled();
  routeAfterClose?.();
  expect(h.push).toHaveBeenCalledExactlyOnceWith(kind === 'cloud' ? '/cloud-chat' : '/group-chat');
});
