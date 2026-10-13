// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as renderUI, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageActions } from '../ChatServerControls';
import type { BotGroupMessageView, ChatReactor } from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({ react: vi.fn(), reactors: vi.fn(), ownerCurrent: true }));
// Interpolating stand-in so the assertions read the composed list, not bare keys.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' },
  t: (key: string, o?: Record<string, unknown>) => {
    const name = key.replace('bots.groupChat.server.', '');
    if (name === 'reactorSelf') return 'You';
    if (name === 'reactorFormer') return `${o?.name} (left)`;
    if (name === 'reactorsUnavailable') return `${o?.count} unavailable`;
    if (name === 'reactionCount') return `${o?.emoji} · ${o?.count}`;
    return name;
  } }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => mocks.ownerCurrent,
}));

const reactor = (actorId: string, name: string | null, extra: Partial<ChatReactor> = {}): ChatReactor =>
  ({ actorId, name, isSelf: false, formerMember: false, ...extra });
const message = (reactions: BotGroupMessageView['reactions']) =>
  ({ id: 'root', authorName: 'Human', content: 'Root', reactions }) as BotGroupMessageView;
const actions = (reactions: BotGroupMessageView['reactions']) =>
  <ChatMessageActions shareScope="group:room" groupId="room" message={message(reactions)} onChanged={vi.fn()} />;
// The message toolbar expects the app-level tooltip provider.
const render = (ui: ReactNode) => {
  const view = renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
  return { ...view, rerender: (next: ReactNode) => view.rerender(<Tooltip.Provider>{next}</Tooltip.Provider>) };
};
const badge = () => screen.getByRole('button', { name: /^👍 · / });
const tooltip = () => screen.findByRole('tooltip');

beforeEach(() => {
  vi.clearAllMocks(); mocks.ownerCurrent = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.react.mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reaction participants', () => {
  it('reads participants on hover intent and lists them without writing a reaction', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [
      reactor('b', 'Zoe'), reactor('c', 'Cindy (Chris)'), reactor('a', 'Dash', { isSelf: true }), reactor('d', 'Cindy (Dana)'),
    ] });
    render(actions([{ emoji: '👍', count: 4, me: true }]));
    fireEvent.pointerEnter(badge());
    // The read starts before the tooltip delay ends, so names are ready when it opens.
    expect(mocks.reactors).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍' });
    fireEvent.pointerMove(badge(), { pointerType: 'mouse' });
    // Same-name companions stay distinct through the owner suffix; the current actor reads "You".
    await waitFor(async () => expect((await tooltip()).textContent).toContain('You, Cindy (Chris), Cindy (Dana), and Zoe'), { timeout: 2000 });
    expect((await tooltip()).textContent).toContain('👍 · 4');
    expect(mocks.react).not.toHaveBeenCalled();
  });

  it('opens on keyboard focus and degrades honestly for former and unresolved members', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [
      reactor('x', null), reactor('y', 'Ada', { formerMember: true }), reactor('z', 'Bo'), reactor('x2', null),
    ] });
    render(actions([{ emoji: '👍', count: 4, me: false }]));
    act(() => badge().focus());
    await waitFor(async () => expect((await tooltip()).textContent).toContain('Bo and Ada (left)'));
    expect((await tooltip()).textContent).toContain('2 unavailable');
  });

  it('says names are unavailable when no reactor has a member record', async () => {
    mocks.reactors.mockResolvedValue({ ok: true, reactors: [reactor('x', null)] });
    render(actions([{ emoji: '👍', count: 1, me: false }]));
    act(() => badge().focus());
    await waitFor(async () => expect((await tooltip()).textContent).toBe(['👍 · 1', '1 unavailable'].join('\n')));
  });

  it('refreshes the list after a live change and ignores the superseded read', async () => {
    let resolveFirst!: (value: unknown) => void;
    mocks.reactors.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('a', 'Dash', { isSelf: true }), reactor('b', 'Zoe')] });
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    act(() => badge().focus());
    expect(await tooltip()).toBeTruthy();
    // A remote add arrives before the first read settles.
    view.rerender(actions([{ emoji: '👍', count: 2, me: true }]));
    await waitFor(async () => expect((await tooltip()).textContent).toContain('You and Zoe'));
    await act(async () => { resolveFirst({ ok: true, reactors: [reactor('b', 'Zoe')] }); });
    expect((await tooltip()).textContent).toContain('You and Zoe');
    expect(mocks.reactors).toHaveBeenCalledTimes(2);
  });

  it('does not show names read for an earlier state of the reaction', async () => {
    mocks.reactors.mockResolvedValueOnce({ ok: true, reactors: [reactor('b', 'Zoe')] })
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    act(() => badge().focus());
    await waitFor(async () => expect((await tooltip()).textContent).toContain('Zoe'));
    act(() => badge().blur());
    view.rerender(actions([{ emoji: '👍', count: 2, me: false }]));
    act(() => badge().focus());
    await waitFor(async () => expect((await tooltip()).textContent).toContain('reactorsLoading'));
    expect((await tooltip()).textContent).not.toContain('Zoe');
  });

  it('keeps click as the only way to toggle and reports a failed read', async () => {
    mocks.reactors.mockResolvedValue({ ok: false, errorCode: 'REQUEST_FAILED' });
    render(actions([{ emoji: '👍', count: 2, me: true }]));
    act(() => badge().focus());
    await waitFor(async () => expect((await tooltip()).textContent).toContain('reactorsFailed'));
    expect(mocks.react).not.toHaveBeenCalled();
    fireEvent.click(badge());
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍', present: false }));
  });

  it('drops a read that settles after the account changed', async () => {
    let resolve!: (value: unknown) => void;
    mocks.reactors.mockImplementation(() => new Promise(r => { resolve = r; }));
    render(actions([{ emoji: '👍', count: 1, me: false }]));
    act(() => badge().focus());
    mocks.ownerCurrent = false;
    await act(async () => { resolve({ ok: true, reactors: [reactor('b', 'Zoe')] }); });
    expect((await tooltip()).textContent).not.toContain('Zoe');
  });

  it('keeps a long list inside the viewport and lets the keyboard scroll it without toggling', async () => {
    const many = Array.from({ length: 300 }, (_, n) => reactor(`p${n}`, `Member ${String(n).padStart(3, '0')}`));
    mocks.reactors.mockResolvedValue({ ok: true, reactors: many });
    // jsdom has no layout: give the scroll region a real overflow.
    const geometry = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'reactor-names' ? 2000 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'reactor-names' ? 240 : 0;
    });
    const scrollBy = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy;
    try {
      render(actions([{ emoji: '👍', count: 300, me: false }]));
      act(() => badge().focus());
      await waitFor(() => expect(document.querySelector('[data-testid="reactor-names"]')?.textContent).toContain('Member 299'));
      const names = document.querySelector<HTMLElement>('[data-testid="reactor-names"]')!;
      // Rendered once (not again as hidden tooltip text), so scrolling targets the visible list.
      expect(document.querySelectorAll('[data-testid="reactor-names"]')).toHaveLength(1);
      // Every name is rendered; the region scrolls inside a viewport-bounded tooltip.
      expect(names.textContent).toContain('Member 000');
      expect(names.className).toContain('overflow-y-auto');
      expect(names.parentElement!.className).toContain('--radix-tooltip-content-available-height');
      await waitFor(() => expect(names.parentElement!.textContent).toContain('reactorsScrollHint'));
      // Screen readers get every name from the label; the scroll hint is for sighted users only.
      expect((await tooltip()).textContent).toContain('Member 299');
      fireEvent.keyDown(badge(), { key: 'PageDown' });
      fireEvent.keyDown(badge(), { key: 'ArrowUp' });
      expect(scrollBy).toHaveBeenNthCalledWith(1, { top: 216 });
      expect(scrollBy).toHaveBeenNthCalledWith(2, { top: -40 });
      expect(mocks.react).not.toHaveBeenCalled();
    } finally { geometry.mockRestore(); client.mockRestore(); }
  });

  it('keeps reading while the pointer moves from the badge into the open list', async () => {
    mocks.reactors.mockResolvedValueOnce({ ok: true, reactors: [reactor('b', 'Zoe')] })
      .mockResolvedValueOnce({ ok: true, reactors: [reactor('b', 'Zoe'), reactor('c', 'Bo')] });
    const view = render(actions([{ emoji: '👍', count: 1, me: false }]));
    fireEvent.pointerEnter(badge());
    fireEvent.pointerMove(badge(), { pointerType: 'mouse' });
    await waitFor(async () => expect((await tooltip()).textContent).toContain('Zoe'), { timeout: 2000 });
    // Leaving the badge toward the hoverable list keeps it open; a remote add still refreshes it.
    fireEvent.pointerLeave(badge());
    view.rerender(actions([{ emoji: '👍', count: 2, me: false }]));
    await waitFor(async () => expect((await tooltip()).textContent).toContain('Bo and Zoe'));
  });
});
