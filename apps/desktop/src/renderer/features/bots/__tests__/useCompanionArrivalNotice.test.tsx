// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  notices: undefined as string[] | undefined,
  toast: vi.fn(),
  dismiss: vi.fn(async (_botId: string) => undefined),
  refresh: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toast } }));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ actors: [{ externalId: 'mia', arrivalNotices: h.notices }] }),
  companionCloudApi: () => ({ dismissCompanionArrivalNotices: h.dismiss }),
  refreshCompanionCloud: h.refresh,
}));

import { useCompanionArrivalNotice } from '../useCompanionArrivalNotice';

describe('useCompanionArrivalNotice', () => {
  beforeEach(() => {
    h.toast.mockClear(); h.dismiss.mockClear(); h.refresh.mockClear();
    h.notices = undefined;
  });

  it('shows a notice once and dismisses it, and shows and dismisses a later arrival of the same companion again', () => {
    const view = renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    h.notices = ['permissions'];
    view.rerender();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    // The snapshot has not been read back yet: a re-render does not repeat it.
    view.rerender();
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    // Main dismissed it; the same companion arrives again in this window.
    h.notices = [];
    view.rerender();
    h.notices = ['permissions'];
    view.rerender();
    expect(h.toast).toHaveBeenCalledTimes(2);
    expect(h.dismiss).toHaveBeenCalledTimes(2);
    // A different set of notices (arrival that adds the model line) is a new batch too.
    h.notices = ['permissions', 'model'];
    view.rerender();
    expect(h.toast).toHaveBeenCalledTimes(4);
    expect(h.dismiss).toHaveBeenCalledTimes(3);
  });
});
