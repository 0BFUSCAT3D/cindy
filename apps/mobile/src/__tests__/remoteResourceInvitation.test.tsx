// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => 'history-request') }));
const h = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() }, generation: 1,
  params: { collectionId: 'teammates', resourceId: 'bot-1', resourceKind: 'bot', deviceId: 'mac', deviceName: 'Mac' },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  read: vi.fn(), action: vi.fn(), upsert: vi.fn(), push: null as null | ((device: string, payload: any) => void),
  link: { openLink: vi.fn(), connectionEpoch: 1, status: 'online', invoke: vi.fn(), onRemoteResourceChanged: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const view = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return { View: view, ScrollView: view, ActivityIndicator: () => null, StyleSheet: { create: (s: any) => s }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Redirect: ({ href }: { href: string }) => { useEffect(() => h.router.replace(href), [href]); return null; }, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => h.router, useLocalSearchParams: () => h.params };
});
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('react-native-safe-area-context', async () => { const { createElement: el } = await import('react'); return { SafeAreaView: ({ children }: any) => el('div', {}, children) }; });
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: 'span', TextInput: ({ value, onChangeText, editable }: { value: string; onChangeText(value: string): void; editable: boolean }) => el('textarea', { value, disabled: !editable, onInput: (event: { currentTarget: { value: string } }) => onChangeText(event.currentTarget.value) }) };
});
vi.mock('@/session/ContextSheet', async () => {
  const { createElement: el } = await import('react');
  return { ContextSheetSelectRow: ({ value, onChange, options }: { value: string; onChange(value: string): void; options: { id: string; label: string }[] }) => el('select', { value, onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value) }, el('option', { value: '' }, 'Choose'), ...options.map(option => el('option', { key: option.id, value: option.id }, option.label))) };
});
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/session/CompanionProfileSheet', async () => {
  const { createElement: el } = await import('react');
  return { CompanionProfileSheet: ({ visible, resource, onClose, onClosed, onOpenSearch }: any) => visible
    ? el('div', {}, el('button', { 'data-testid': 'profile-settings', onClick: () => { onClose(); onClosed(); } }, resource.ref.id), onOpenSearch ? el('button', { 'data-testid': 'profile-history', onClick: () => { onOpenSearch(); onClosed(); } }, 'History') : null)
    : null };
});
vi.mock('@/components/MobilePrimitives', async () => {
  const { createElement: el } = await import('react');
  return { MainWindowEmptyState: ({ copy }: any) => el('span', {}, copy), MainWindowActionButton: ({ action }: any) => el('button', { onClick: action.onPress, disabled: action.disabled, 'data-testid': action.testID }, action.label) };
});
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteStatus', async () => ({ ...await vi.importActual<typeof import('@/device-link/remoteStatus')>('@/device-link/remoteStatus'), formatRemoteError: String }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResources', async (importOriginal) => ({ ...await importOriginal<typeof import('../device-link/remoteResources')>(), getRemoteResource: h.read, invokeRemoteResourceAction: h.action }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { getSessionDeviceId: () => null, upsertDeviceSession: h.upsert } }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
import Screen from '../../app/resources/[collectionId]/[resourceId]';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const resource = (stage: string) => ({ ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, display: { title: 'Mimi' }, revision: stage, links: stage === 'ready' ? [{ rel: 'conversation', target: { kind: 'session', sessionId: 'chat-1' } }] : [], blocks: [{ id: 'invitation', primitive: 'status', fallbackMarkdown: '', data: { stage } }], actions: stage === 'failed' ? [{ id: 'opaque-retry', label: 'Retry' }] : [] });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks(); h.link.openLink.mockResolvedValue(undefined); h.generation = 1; h.params.collectionId = 'teammates';
  h.params.resourceId = 'bot-1'; h.params.resourceKind = 'bot';
  h.link.onRemoteResourceChanged.mockImplementation(callback => { h.push = callback; return () => { h.push = null; }; });
  h.link.invoke.mockResolvedValue({ id: 'chat-1', source: 'bot' });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });
it('keeps preparation in place and opens the canonical chat only after the host is ready', async () => {
  h.read.mockResolvedValue(resource('skills'));
  await act(async () => root.render(createElement(Screen)));
  expect(container.textContent).toContain('devices.companions.invitation.skills');
  expect(h.router.replace).not.toHaveBeenCalled();
  h.read.mockResolvedValue(resource('ready'));
  await act(async () => h.push!('mac', { collectionId: 'teammates' }));
  expect(h.upsert).toHaveBeenCalledWith('mac', 'Mac', { id: 'chat-1', source: 'bot' });
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
});
it('retries failed preparation through the advertised action without creating another teammate', async () => {
  h.read.mockResolvedValue(resource('failed'));
  h.action.mockImplementation(async () => { h.read.mockResolvedValue(resource('skills')); return { effects: [] }; });
  await act(async () => root.render(createElement(Screen)));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remoteResourceResolver.retryInvitation"]')!.click());
  expect(h.action).toHaveBeenCalledWith(h.link.invoke, { deviceId: 'mac', deviceName: 'Mac' }, expect.objectContaining({ actionId: 'opaque-retry', resourceRef: resource('failed').ref }), 'en');
  expect(container.textContent).toContain('devices.companions.invitation.skills');
});
it.each(['welcome', 'failed'])('opens settings while preparation is %s and defers navigation until editing ends', async stage => {
  h.read.mockResolvedValue(resource(stage));
  await act(async () => root.render(createElement(Screen)));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remoteResourceResolver.settings"]')!.click());
  expect(container.querySelector('[data-testid="profile-settings"]')?.textContent).toBe('bot-1');
  h.read.mockResolvedValue(resource('ready'));
  await act(async () => h.push!('mac', { collectionId: 'teammates' }));
  expect(h.router.replace).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="profile-settings"]')!.click());
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
  expect(h.action).not.toHaveBeenCalled();
});
it('ignores a late ready response from the previous account', async () => {
  let finish!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(resource('failed'));
  await act(async () => root.render(createElement(Screen)));
  h.generation = 2;
  await act(async () => root.render(createElement(Screen)));
  await act(async () => finish(resource('ready')));
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(h.upsert).not.toHaveBeenCalled();
});
it('keeps settings open when a ready chat finishes loading during a model edit', async () => {
  h.read.mockResolvedValue(resource('failed'));
  await act(async () => root.render(createElement(Screen)));
  let finish!: (value: unknown) => void;
  h.link.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  h.read.mockResolvedValue(resource('ready'));
  await act(async () => h.push!('mac', { collectionId: 'teammates' }));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remoteResourceResolver.settings"]')!.click());
  await act(async () => finish({ id: 'chat-1', source: 'bot' }));
  expect(h.router.replace).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="profile-settings"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="profile-settings"]')!.click());
  expect(h.router.replace).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]' }));
});
it('keeps a failed preparation on screen with an inline notice when its retry fails', async () => {
  h.read.mockResolvedValue(resource('failed'));
  h.action.mockRejectedValue(new Error('[DEVICE_UNRESPONSIVE] mac'));
  await act(async () => root.render(createElement(Screen)));
  expect(container.textContent).toContain('devices.companions.invitation.failed');
  expect(container.textContent).not.toContain('devices.companions.invitation.background');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remoteResourceResolver.retryInvitation"]')!.click());
  expect(container.querySelector('[data-testid="remoteResourceResolver.preparation"]')).not.toBeNull();
  expect(container.textContent).toContain('devices.companions.invitation.retryFailed');
  expect(container.textContent).not.toContain('DEVICE_UNRESPONSIVE');
});
it('reassures the user while preparing and shows the live stage beside the spinner', async () => {
  h.read.mockResolvedValue(resource('profile'));
  await act(async () => root.render(createElement(Screen)));
  expect(container.textContent).toContain('devices.companions.invitation.background');
  expect(container.querySelector('[data-testid="remoteResourceResolver.preparationStage"]')?.textContent).toBe('devices.companions.invitation.profile');
});

it('redirects stale routine links without reading or subscribing to the host', async () => {
  h.params.collectionId = 'routines';
  await act(async () => root.render(createElement(Screen)));
  expect(h.router.replace).toHaveBeenCalledWith('/devices');
  expect(h.read).not.toHaveBeenCalled();
  expect(h.action).not.toHaveBeenCalled();
  expect(h.link.onRemoteResourceChanged).not.toHaveBeenCalled();
});

it('opens existing history after the failed teammate settings close', async () => {
  h.read.mockResolvedValue({ ...resource('failed'), links: resource('ready').links });
  await act(async () => root.render(createElement(Screen)));
  await act(async () => (container.querySelector('[data-testid="remoteResourceResolver.settings"]') as HTMLButtonElement).click());
  expect(h.router.push).not.toHaveBeenCalled();
  await act(async () => (container.querySelector('[data-testid="profile-history"]') as HTMLButtonElement).click());
  expect(h.router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]', params: expect.objectContaining({ sessionId: 'chat-1', deviceId: 'mac', openSearch: '1', openSearchRequest: 'history-request' }) }));
});

/** 测试价值：同一生产资源路由新增原生 Agent 分支；不应进入旧 Session 查询或自动发送。
 * 旧伙伴回归未覆盖原生任务。最小输入为 opaque start/send action、丢失回执和账号切换。
 * tier: unit；替换原生控件，不替换路由、Agent 屏幕或表单行为。 */
function nativeResource(id = 'catalog') {
  h.params.collectionId = 'agent-adapters'; h.params.resourceKind = 'native-agent-run'; h.params.resourceId = id;
  return { ref: { collectionId: h.params.collectionId, kind: h.params.resourceKind, id }, display: { title: 'Cursor' }, revision: '1', links: [], blocks: [{ id: 'output', primitive: 'text', fallbackMarkdown: 'Native output' }], actions: id === 'catalog'
    ? [{ id: 'start', label: 'New task', fields: [{ id: 'instanceId', label: 'Agent', kind: 'select', required: true, options: [{ value: 'cursor:local', label: 'Cursor' }] }, { id: 'workspaceId', label: 'Working directory', kind: 'select', required: true, options: [{ value: 'project', label: 'Project' }] }] }]
    : [{ id: 'send', label: 'Send', fields: [{ id: 'text', label: 'Message', kind: 'multiline', required: true }] }] };
}
const nativeButton = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label)!;
it('opens a native resource without querying the old Session or sending until explicit selections', async () => {
  h.read.mockResolvedValue(nativeResource()); h.action.mockResolvedValue({ effects: [] });
  await act(async () => root.render(createElement(Screen)));
  expect(container.textContent).toContain('Native output'); expect(h.link.invoke).not.toHaveBeenCalled();
  expect(nativeButton('New task').disabled).toBe(true); expect(h.action).not.toHaveBeenCalled();
  const selects = container.querySelectorAll('select');
  await act(async () => { selects[0]!.value = 'cursor:local'; selects[0]!.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(nativeButton('New task').disabled).toBe(true);
  await act(async () => { selects[1]!.value = 'project'; selects[1]!.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => nativeButton('New task').click());
  expect(h.action).toHaveBeenCalledTimes(1);
  expect(h.action.mock.calls[0]?.[2]).toMatchObject({ collectionId: 'agent-adapters', actionId: 'start', input: { instanceId: 'cursor:local', workspaceId: 'project', requestId: expect.any(String) } });
});
it('keeps a native draft and receipt after an uncertain send; refresh never resends', async () => {
  h.read.mockResolvedValue(nativeResource('run-1')); h.action.mockRejectedValue(new Error('lost acknowledgement'));
  await act(async () => root.render(createElement(Screen)));
  await act(async () => { const input = container.querySelector('textarea')!; input.value = 'Work'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => nativeButton('Send').click());
  expect(h.action).toHaveBeenCalledTimes(1);
  expect(container.querySelector('textarea')!.value).toBe('Work'); expect(nativeButton('Send').disabled).toBe(true);
  const request = h.action.mock.calls[0]?.[2];
  await act(async () => nativeButton('Refresh').click());
  expect(h.action).toHaveBeenCalledTimes(1);
  h.action.mockResolvedValue({ effects: [] });
  await act(async () => nativeButton('Send').click());
  expect(h.action.mock.calls[1]?.[2]).toEqual(request);
});
it('drops a native read completing after the controller account changes', async () => {
  const stale = nativeResource('run-1');
  let finish!: (value: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...stale, blocks: [] });
  await act(async () => root.render(createElement(Screen)));
  h.generation = 2;
  await act(async () => root.render(createElement(Screen)));
  await act(async () => finish(stale));
  expect(container.textContent).not.toContain('Native output'); expect(h.action).not.toHaveBeenCalled();
});
