// @vitest-environment jsdom
// Regression: IM records were inaccessible on both mobile presentations. Exercise the
// shared record picker with the real request envelope; opening must not reset a lane. Unit tier.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionChannelTasks } from '@/session/CompanionChannelTasks';
const h = vi.hoisted(() => ({ requests: [] as any[], supported: true, fail: false, refresh: vi.fn() }));
vi.mock('@/session/useRemoteCompanionQuery', () => ({ useRemoteCompanionQuery: (device: string, channel: string, args: any[], options: any) => {
  const request = args[0];
  if (options.enabled) h.requests.push({ device, channel, request });
  const op = request.input.op;
  const value = op === 'caps' ? { ops: h.supported ? ['channels.im.list', 'channels.im.listLanes'] : [] }
    : op === 'channels.im.list' ? { connections: [{ id: 'connection', botId: 'bot', channel: 'telegram' }, { id: 'other', botId: 'other-bot', channel: 'discord' }] }
      : { lanes: [{ sessionId: 'original-lane', name: 'Release group', chatId: 'group', kind: 'group' }] };
  return { value: options.enabled ? { result: { ok: !h.fail, value } } : null, error: false, refresh: h.refresh };
} }));
vi.mock('react-native', () => ({ View: ({ children }: any) => createElement('div', {}, children), StyleSheet: { create: (s: unknown) => s } }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { disabled: action.disabled, onClick: action.onPress }, action.label) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', async () => { const tokens = await import('@/theme/tokens'); return { ...tokens, useThemedStyles: (make: any) => make(tokens.lightColors) }; });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
let root = createRoot(host);
const open = vi.fn();
const render = (online = true) => act(async () => root.render(<CompanionChannelTasks deviceId="studio" botId="bot" online={online} onOpenTask={open} />));
afterEach(() => { act(() => root.unmount()); root = createRoot(host); h.requests = []; h.supported = true; h.fail = false; vi.clearAllMocks(); });
it('opens the exact channel task and only reads the selected connection on its computer', async () => {
  await render();
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(h.requests.some(row => row.request.input.op === 'channels.im.listLanes')).toBe(false);
  await act(async () => host.querySelector('button')!.click());
  expect(h.requests.at(-1)).toMatchObject({ device: 'studio', channel: 'maker:remote-resources:invoke', request: {
    resourceRef: { id: 'bot' }, input: { v: 1, op: 'channels.im.listLanes', args: { id: 'connection' } },
  } });
  await act(async () => host.querySelectorAll('button')[1]!.click());
  expect(open).toHaveBeenCalledWith('original-lane');
  expect(h.requests.every(row => ['caps', 'channels.im.list', 'channels.im.listLanes'].includes(row.request.input.op))).toBe(true);
});
it('explains offline, unsupported hosts and logical failures instead of an empty picker', async () => {
  await render(false); expect(host.textContent).toContain('devices.resources.hostOffline');
  expect(h.requests).toHaveLength(0);
  h.supported = false; await render(); expect(host.textContent).toContain('devices.companionProfile.hostUpgrade');
  h.fail = true; await render(); expect(host.textContent).toContain('devices.companionProfile.readFailed');
  await act(async () => host.querySelector('button')!.click()); expect(h.refresh).toHaveBeenCalled();
});
