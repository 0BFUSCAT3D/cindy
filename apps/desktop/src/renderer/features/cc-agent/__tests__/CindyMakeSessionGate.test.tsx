// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeSessionGate } from '../CindyMakeSessionGate';

const state = vi.hoisted(() => ({ remote: [] as Array<{ id: string; source: string }>, localSource: undefined as string | undefined, getSession: vi.fn() }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {
  subscribe: () => () => {}, getMergedRemoteSessions: () => state.remote,
} }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: {
  subscribe: () => () => {}, findById: () => state.localSource ? { source: state.localSource } : null,
} }));
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: state.getSession }));
afterEach(cleanup);
beforeEach(() => { state.remote = []; state.localSource = undefined; state.getSession.mockReset(); });

function mount(child: React.ReactNode = <div>Composer</div>) {
  return render(<MemoryRouter initialEntries={['/old-task']}>
    <Routes>
      <Route path="/old-task" element={<CindyMakeSessionGate sessionId="old-task">{child}</CindyMakeSessionGate>} />
      <Route path="/cc-agent" element={<div>Task list</div>} />
    </Routes>
  </MemoryRouter>);
}

describe('old Cindy Make links', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('redirects a mirrored %s task before mounting its composer', (source) => {
    state.remote = [{ id: 'old-task', source }];
    const Composer = vi.fn(() => <div>Composer</div>);
    mount(<Composer />);
    expect(screen.getByText('Task list')).toBeTruthy();
    expect(Composer).not.toHaveBeenCalled();
    expect(state.getSession).not.toHaveBeenCalled();
  });

  it('waits for metadata and redirects a hidden task missing from visible lists', async () => {
    let resolve!: (value: { source: string }) => void;
    state.getSession.mockReturnValue(new Promise(res => { resolve = res; }));
    const Composer = vi.fn(() => <div>Composer</div>);
    mount(<Composer />);
    expect(Composer).not.toHaveBeenCalled();
    await act(async () => resolve({ source: 'cindy-make' }));
    expect(screen.getByText('Task list')).toBeTruthy();
    expect(Composer).not.toHaveBeenCalled();
  });

  it('opens an ordinary cached task without an extra metadata request', () => {
    state.localSource = 'desktop';
    mount();
    expect(screen.getByText('Composer')).toBeTruthy();
    expect(state.getSession).not.toHaveBeenCalled();
  });
});
