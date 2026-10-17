// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { RemoteAgentIdleReleaseSection } from '../RemoteAgentIdleReleaseSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const command = vi.fn();
const view = (idleMinutes = 10, isCustomized = false) => ({ value: { idleMinutes }, defaults: { idleMinutes: 10 }, isCustomized });
const input = () => screen.getByTestId('remote-agent-idle-release-minutes') as HTMLInputElement;
const button = (key: 'save' | 'reset') => screen.getByRole('button', { name: `providerShare.idleRelease.${key}` }) as HTMLButtonElement;

beforeEach(() => {
  setDataOwnerGeneration('owner-a');
  command.mockReset().mockImplementation(async (cmd: { action: string; value?: { idleMinutes: number } }) => (
    cmd.action === 'set-idle-release' ? view(cmd.value!.idleMinutes, true) : view()
  ));
  Object.assign(window, { electronAPI: { providerShare: { command } } });
});
afterEach(() => cleanup());

describe('RemoteAgentIdleReleaseSection', () => {
  it('reads and saves the setting on this computer, including 0 and an explicit default', async () => {
    render(<RemoteAgentIdleReleaseSection />);
    await waitFor(() => expect(input().value).toBe('10'));
    expect(command).toHaveBeenCalledWith({ action: 'get-idle-release' });
    expect(screen.getByText('providerShare.idleRelease.hint')).toBeTruthy();
    expect(button('save').disabled).toBe(true);
    fireEvent.change(input(), { target: { value: '0' } });
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'set-idle-release', value: { idleMinutes: 0 } }));
    await waitFor(() => expect(button('reset').disabled).toBe(false));
    fireEvent.change(input(), { target: { value: '10' } });
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'set-idle-release', value: { idleMinutes: 10 } }));
  });

  it('rejects values outside 0–120 and restores the default', async () => {
    command.mockImplementation(async (cmd: { action: string }) => (cmd.action === 'reset-idle-release' ? view() : view(30, true)));
    render(<RemoteAgentIdleReleaseSection />);
    await waitFor(() => expect(input().value).toBe('30'));
    for (const value of ['121', '-1', '1.5', '']) {
      fireEvent.change(input(), { target: { value } });
      expect(button('save').disabled).toBe(true);
    }
    expect(screen.getByRole('alert').textContent).toBe('providerShare.idleRelease.invalid');
    fireEvent.click(button('reset'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'reset-idle-release' }));
    await waitFor(() => expect(input().value).toBe('10'));
  });
});
