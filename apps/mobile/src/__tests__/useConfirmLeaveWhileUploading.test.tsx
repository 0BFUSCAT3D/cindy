// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmLeaveWhileUploading } from '@/session/useConfirmLeaveWhileUploading';

const h = vi.hoisted(() => ({
  prevent: vi.fn(),
  alert: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock('react-native', () => ({ Alert: { alert: h.alert } }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: h.dispatch }) }));
vi.mock('expo-router/react-navigation', () => ({ usePreventRemove: h.prevent }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mount(active: boolean) {
  let confirmed!: { current: boolean };
  function Harness() {
    confirmed = useConfirmLeaveWhileUploading(active);
    return null;
  }
  act(() => root.render(<Harness />));
  const [enabled, onPrevent] = h.prevent.mock.calls.at(-1)!;
  return { enabled, onPrevent, confirmed };
}

describe('useConfirmLeaveWhileUploading', () => {
  it('only blocks leaving while a send waits on uploads', () => {
    expect(mount(false).enabled).toBe(false);
    expect(mount(true).enabled).toBe(true);
  });

  it('keeps waiting on cancel and leaves, marking the send abandoned, on discard', () => {
    const { onPrevent, confirmed } = mount(true);
    const action = { type: 'GO_BACK' };
    onPrevent({ data: { action } });
    const [, , buttons] = h.alert.mock.calls[0];
    const stay = buttons.find((b: { style?: string }) => b.style === 'cancel');
    const discard = buttons.find((b: { style?: string }) => b.style === 'destructive');

    stay.onPress?.();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(confirmed.current).toBe(false);

    discard.onPress();
    expect(h.dispatch).toHaveBeenCalledWith(action);
    expect(confirmed.current).toBe(true);
  });
});
