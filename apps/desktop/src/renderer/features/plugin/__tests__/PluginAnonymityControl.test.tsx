/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyPluginDetailView } from '../../../../shared/pluginContributions';
import { PluginAnonymityControl } from '../PluginAnonymityControl';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const copy = 'settings.ghosts.contribution';
function response(anonymous: boolean): MyPluginDetailView {
  return {
    plugin: { pluginId: 'plugin', name: 'Plugin', authorSettings: { anonymous, canEdit: true },
      iconUrl: null, updatedAt: '2026-10-19T00:00:00Z',
      market: { state: 'not_listed', version: null, releaseId: null, reason: null },
      latestSubmission: null, actions: { submitUpdate: false, viewMarket: false }, localInstanceId: null },
    history: [], nextCursor: null, queriedAt: '2026-10-19T00:00:00Z',
  };
}
function deferred() {
  let resolve!: (result: MyPluginDetailView) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<MyPluginDetailView>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const pending = deferred();
  const reader = { setAnonymity: vi.fn(() => pending.promise) };
  const onUpdated = vi.fn(), onCommitted = vi.fn();
  const props = { ownerKey: 'owner:1', pluginId: 'plugin', settings: { anonymous: true, canEdit: true },
    reader, onUpdated, onCommitted };
  return { pending, props, reader, onUpdated, onCommitted };
}

describe('plugin-level anonymity control', () => {
  it('does not infer editing rights from a plugin being visible', () => {
    const { props, reader } = setup();
    render(<PluginAnonymityControl {...props} settings={{ anonymous: false, canEdit: false }} />);
    const control = screen.getByRole('switch') as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(control);
    expect(reader.setAnonymity).not.toHaveBeenCalled();
    expect(screen.getByText(`${copy}.anonymousAuthorOnly`)).toBeTruthy();
  });

  it('keeps the confirmed value until the server replies, including StrictMode replay', async () => {
    const { props, reader, pending, onUpdated, onCommitted } = setup();
    render(<StrictMode><PluginAnonymityControl {...props} /></StrictMode>);
    const control = screen.getByRole('switch') as HTMLButtonElement;
    fireEvent.click(control);
    fireEvent.click(control);
    expect(reader.setAnonymity).toHaveBeenCalledExactlyOnceWith('plugin', false);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-checked')).toBe('true');
    const result = response(false);
    await act(async () => pending.resolve(result));
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(result);
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(result, true);
    expect(control.disabled).toBe(false);
  });

  it('invalidates parent caches after a committed write even if navigation removed the control', async () => {
    const { props, pending, onUpdated, onCommitted } = setup();
    const view = render(<PluginAnonymityControl {...props} />);
    fireEvent.click(screen.getByRole('switch'));
    view.unmount();
    const result = response(false);
    await act(async () => pending.resolve(result));
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(result, false);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('does not apply a late write to a different owner or plugin', async () => {
    const { props, pending, onUpdated } = setup();
    const view = render(<PluginAnonymityControl {...props} />);
    fireEvent.click(screen.getByRole('switch'));
    view.rerender(<PluginAnonymityControl {...props} ownerKey="owner:2" pluginId="another-plugin" />);
    await act(async () => pending.resolve(response(false)));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('discards the old completion after an owner leaves and returns with a new generation', async () => {
    const { props, pending, onUpdated, onCommitted } = setup();
    const view = render(<PluginAnonymityControl {...props} />);
    fireEvent.click(screen.getByRole('switch'));
    view.rerender(<PluginAnonymityControl {...props} ownerKey="other-owner:1" />);
    view.rerender(<PluginAnonymityControl {...props} ownerKey="owner:2" />);
    await act(async () => pending.resolve(response(false)));
    expect(onUpdated).not.toHaveBeenCalled();
    // The parent rechecks its owner generation before invalidating any cache.
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('preserves the confirmed state and exposes failure rather than pretending the write succeeded', async () => {
    const { props, pending, onUpdated, onCommitted } = setup();
    render(<PluginAnonymityControl {...props} />);
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => pending.reject(new Error('network unavailable')));
    expect(screen.getByRole('alert').textContent).toBe(`${copy}.anonymousUpdateFailed`);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(onUpdated).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('does not fabricate an enabled default for missing authorship or loading settings', () => {
    const { props, reader } = setup();
    const view = render(<PluginAnonymityControl {...props} settings={null} unavailable />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`${copy}.anonymousUnavailable`);
    view.rerender(<PluginAnonymityControl {...props} settings={undefined} loading />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`${copy}.loading`);
    expect(reader.setAnonymity).not.toHaveBeenCalled();
  });
});
