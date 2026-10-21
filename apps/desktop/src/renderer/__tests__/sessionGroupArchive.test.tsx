// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionGroupArchive } from '@/features/cc-agent/hooks/useSessionGroupArchive';
import {
  projectIdentityKeyForSession,
  type ProjectNode,
} from '@/features/cc-agent/lib/projectGrouping';
import type { FilterStatus } from '@/features/cc-agent/hooks/useSidebarFilter';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { emitRefresh } from '@/lib/sessionsBus';
import { toast } from '@/lib/toast';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));
vi.mock('@/lib/sessionService', () => ({ setStatus: vi.fn(), restoreIfArchived: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() },
}));
vi.mock('@/lib/composerDraftStore', () => ({ discardDraft: vi.fn() }));
vi.mock('@/lib/worktreeRemovalWarning', () => ({
  countDirtyWorktreesForRemoval: vi.fn(async () => 0),
}));
vi.mock('@/lib/sessionsBus', () => ({ emitRefresh: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

// Value: invoke the production group lifecycle and inspect persisted writes,
// confirmation scope and cleanup. The existing candidate-selector unit tests
// do not exercise this orchestration. Rule: dedicated dialogue menu must not
// affect project/Bot/Make tasks or a local subset of a remote/mixed group.
// Minimal input: one eligible member plus pinned/running/foreign records.
// Tier: unit; in-memory persistence and immediate confirmations, no real waits.
// Standalone Vitest: 2.53s (1.51s collection).
function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    status: 'active',
    workspaceKind: 'dialogue',
    pinnedAt: null,
    workingDir: `/dialogues/${id}`,
    ...patch,
  } as Session;
}

function mount(sessions: Session[], status: FilterStatus = 'active') {
  const writes = new Map(sessions.map((s) => [s.id, s]));
  vi.mocked(sessionService.setStatus).mockImplementation(async (id, nextStatus) => {
    const updated = { ...writes.get(id)!, status: nextStatus };
    writes.set(id, updated);
    return updated;
  });
  const options = {
    sessions,
    status,
    runningSessionIds: new Set(['running']),
    viewedSessionId: 'eligible',
    confirmDialog: vi.fn<(options: ConfirmOptions) => Promise<boolean>>(async () => true),
    refreshSessions: vi.fn(async () => undefined),
    patchLocal: vi.fn(),
    navigate: vi.fn(),
  };
  const view = renderHook(() => useSessionGroupArchive(options));
  return { ...view, options, writes };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('session group bulk lifecycle', () => {
  it('archives only eligible group members, with dialogue confirmation and normal cleanup', async () => {
    const members = [
      session('eligible'),
      session('running'),
      session('pinned', { pinnedAt: '2026-10-21' }),
      session('archived', { status: 'archived' }),
    ];
    const foreign = [
      session('project', { workspaceKind: 'project' }),
      session('bot'),
      session('make'),
    ];
    const view = mount([...members, ...foreign]);
    await act(async () => {
      await view.result.current({ kind: 'dialogue', sessions: members });
    });
    expect(view.writes.get('eligible')?.status).toBe('archived');
    expect(
      [...view.writes.values()].filter((s) => s.status === 'archived').map((s) => s.id),
    ).toEqual(['eligible', 'archived']);
    const description = view.options.confirmDialog.mock.calls[0][0].description;
    expect(description).toContain('ccAgent.sidebar.dialogueArchiveAll.descriptionWithSkip');
    expect(description).toContain('"count":1');
    expect(description).toContain('skipPinned');
    expect(description).toContain('skipRunning');
    expect(makerChatStore.closeSessionQuery).toHaveBeenCalledExactlyOnceWith('eligible');
    expect(makerChatStore.purgeSession).toHaveBeenCalledExactlyOnceWith('eligible');
    expect(view.options.navigate).toHaveBeenCalledWith('/cc-agent');
  });

  it('leaves records and active queries untouched when the confirmation is cancelled', async () => {
    const members = [session('eligible')];
    const view = mount(members);
    view.options.confirmDialog.mockResolvedValue(false);
    await act(async () => {
      await view.result.current({ kind: 'dialogue', sessions: members });
    });
    expect(view.writes.get('eligible')?.status).toBe('active');
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
    expect(view.options.refreshSessions).not.toHaveBeenCalled();
  });

  it('restores archived members with identity checks and reports partial failures without archiving active tasks', async () => {
    const members = [
      session('eligible'),
      session('restored', { status: 'archived' }),
      session('moved', { status: 'archived' }),
      session('failed', { status: 'archived' }),
    ];
    const view = mount(members, 'archived');
    vi.mocked(sessionService.restoreIfArchived)
      .mockResolvedValueOnce({ ...members[1], status: 'active' })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('write failed'));
    await act(async () => {
      await view.result.current({ kind: 'dialogue', sessions: members });
    });
    expect(vi.mocked(sessionService.restoreIfArchived).mock.calls).toEqual(
      members.slice(1).map((s) => [s.id, s]),
    );
    expect(view.options.patchLocal).toHaveBeenCalledExactlyOnceWith('restored', {
      status: 'active',
    });
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'dialogueRestoreAll.description',
    );
    expect(toast.error).toHaveBeenCalledWith(
      'ccAgent.sidebar.unarchiveAll.partialFailure:{"ok":1,"fail":2}',
    );
    expect(emitRefresh).toHaveBeenCalledOnce();
    expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(makerChatStore.closeSessionQuery).not.toHaveBeenCalled();
  });

  it.each(['active', 'archived'] as const)(
    'rejects remote/mixed groups before any %s writes even when invoked directly',
    async (status) => {
      const members = [
        session('eligible', { status }),
        session('remote', { status, deviceLinkDeviceId: 'remote' }),
      ];
      const view = mount(members, status);
      await act(async () => {
        await view.result.current({ kind: 'dialogue', sessions: members });
      });
      expect(view.options.confirmDialog).not.toHaveBeenCalled();
      expect(sessionService.setStatus).not.toHaveBeenCalled();
      expect(sessionService.restoreIfArchived).not.toHaveBeenCalled();
      expect(toast.warning).toHaveBeenCalledWith(
        'ccAgent.sidebar.dialogueAction.remoteBulkUnavailable',
      );
    },
  );

  it('retains project scope and project wording through the shared lifecycle', async () => {
    const projectTask = session('project', { workspaceKind: 'project', workingDir: '/repo' });
    const view = mount([projectTask, session('dialogue')]);
    const project = {
      projectKey: projectIdentityKeyForSession(projectTask),
      sessions: [projectTask],
    } as ProjectNode;
    await act(async () => {
      await view.result.current({ kind: 'project', project });
    });
    expect(view.writes.get('project')?.status).toBe('archived');
    expect(view.writes.get('dialogue')?.status).toBe('active');
    expect(view.options.confirmDialog.mock.calls[0][0].description).toContain(
      'ccAgent.sidebar.archiveAll.description',
    );
  });
});
