// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { useAutoResumeNewSessionDraft, useNewSessionDurableEdit } from '@/session/useNewSessionDraftRecovery';

const outbox = vi.hoisted(() => ({
  records: [] as DurableOutboxRecord[], listeners: new Set<() => void>(),
  ready: vi.fn(), claim: vi.fn(), release: vi.fn(), find: vi.fn(), merge: vi.fn(),
}));
vi.mock('@/session/mobileDurableOutbox', () => ({
  getCurrentMobileOutboxRecords: () => outbox.records,
  mobileDurableOutbox: {
    ready: outbox.ready,
    subscribe: (listener: () => void) => {
      outbox.listeners.add(listener);
      return () => outbox.listeners.delete(listener);
    },
  },
}));
vi.mock('@/session/newSessionCreation', () => ({
  completeNewSessionDurableEdit: outbox.claim,
  findNewSessionEditDraft: outbox.find,
}));
vi.mock('@/session/mergeNewSessionEditFollowUps', () => ({ mergeNewSessionEditFollowUps: outbox.merge }));
type EditProps = Omit<Parameters<typeof useNewSessionDurableEdit>[0], 'onRestore'>;
type ResumeProps = Omit<Parameters<typeof useAutoResumeNewSessionDraft>[0], 'onResume'>;
function Editor(props: EditProps) {
  const [record, setRecord] = useState<DurableOutboxRecord>();
  const [text, setText] = useState('');
  useNewSessionDurableEdit({ ...props, onRestore: saved => {
    setRecord(saved); setText(saved.creation.draft.firstMessage);
  } });
  return <><span>{text}</span><span>{record?.error}</span>
    <button onClick={() => setText('New input')}>Edit</button></>;
}
function BlankForm(props: ResumeProps) {
  const [route, setRoute] = useState('');
  useAutoResumeNewSessionDraft({ ...props, onResume: params => setRoute(`${params.deviceId}/${params.recoverySessionId}`) });
  return <span>{route}</span>;
}
let root: Root;
let container: HTMLDivElement;
let edit: EditProps;
let resume: ResumeProps;
let ready: () => void;
let hasInput: boolean;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
const renderEdit = () => act(async () => root.render(<Editor {...edit} />));
const renderBlank = () => act(async () => root.render(<BlankForm {...resume} />));
const notify = () => act(async () => { for (const listener of outbox.listeners) listener(); });
beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  setMobileAuthOwner('account');
  const owner = getMobileAuthOwner();
  outbox.listeners.clear();
  outbox.release.mockReset();
  outbox.claim.mockReset().mockReturnValue(outbox.release);
  outbox.ready.mockReset().mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  outbox.records = [{
    version: 1, accountId: owner.accountKey, deviceId: 'device', state: 'failed', createdAt: 1,
    uploads: [], error: 'Model unavailable',
    item: { sessionId: 'task', clientId: 'first', text: 'Saved draft', attachmentSlots: [],
      quotesEncoded: false, agentReferences: [], pastedTextRanges: [], slashCommandRanges: [],
      permissionModeAtSend: 'auto', slotMeta: [], slotByLocalId: {}, waitingIds: [],
      failedIds: [], enqueueError: null, phase: 'failed' },
    creation: { deviceName: 'PC', planModeArm: false, restorePermissionMode: null,
      draft: { agentKind: 'codex', workspaceKind: 'dialogue', model: 'model', effort: 'medium',
        permissionMode: 'auto', workingDir: '', providerId: 'openai', fastMode: false, firstMessage: 'Saved draft' } },
  }];
  outbox.find.mockReset().mockImplementation(() => outbox.records[0]);
  outbox.merge.mockReset().mockImplementation(async () => outbox.records[0]);
  edit = { sessionId: 'task', deviceId: 'device', owner, leaveForeignRecovery: () => false };
  hasInput = false;
  resume = { enabled: true, deviceId: 'device', workingDir: '/repo', owner, hasInput: () => hasInput };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setMobileAuthOwner(null);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('restores text and the saved failure once, preserving edits across renders and notifications', async () => {
  await renderEdit();
  expect(container.textContent).toBe('Edit');
  await act(async () => ready());
  expect(container.textContent).toBe('Saved draftModel unavailableEdit');
  expect(outbox.claim).toHaveBeenCalledExactlyOnceWith('task', 'device');
  act(() => container.querySelector('button')!.click());
  await renderEdit();
  await notify();
  expect(container.textContent).toBe('New inputModel unavailableEdit');
  expect(outbox.claim).toHaveBeenCalledOnce();
  expect(outbox.release).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(outbox.release).toHaveBeenCalledOnce();
  expect(outbox.listeners.size).toBe(0);
});

it.each(['account', 'device', 'prepared', 'foreign-route', 'unmount', 'owner-switch'] as const)(
  'ignores ineligible or late durable recovery: %s', async change => {
    if (change === 'account') outbox.records[0].accountId = 'other';
    if (change === 'device') outbox.records[0].deviceId = 'other';
    if (change === 'prepared') outbox.records[0].prepared = {} as NonNullable<DurableOutboxRecord['prepared']>;
    if (change === 'foreign-route') edit.leaveForeignRecovery = () => true;
    await renderEdit();
    if (change === 'unmount') await act(async () => root.render(null));
    if (change === 'owner-switch') setMobileAuthOwner('other');
    await act(async () => ready());
    await notify();
    expect(outbox.claim).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Saved draft');
  },
);

it('releases the old claim when the route changes and waits for the matching record', async () => {
  await renderEdit();
  await act(async () => ready());
  edit = { ...edit, sessionId: 'next' };
  await renderEdit();
  expect(outbox.release).toHaveBeenCalledOnce();
  outbox.records[0] = { ...outbox.records[0], item: { ...outbox.records[0].item, sessionId: 'next' } };
  await notify();
  expect(outbox.claim).toHaveBeenLastCalledWith('next', 'device');
  expect(outbox.claim).toHaveBeenCalledTimes(2);
});

it('resumes one draft in the selected device and project, without repeating on render or notification', async () => {
  await renderBlank();
  await act(async () => ready());
  expect(container.textContent).toBe('device/task');
  expect(outbox.find).toHaveBeenCalledExactlyOnceWith('device', '/repo');
  await renderBlank();
  await notify();
  expect(outbox.find).toHaveBeenCalledOnce();
});

it.each(['disabled', 'input', 'late-input', 'unmount', 'owner-switch'] as const)(
  'does not resume over a protected or stale form: %s', async change => {
    if (change === 'disabled') resume.enabled = false;
    if (change === 'input') hasInput = true;
    await renderBlank();
    if (change === 'late-input') { hasInput = true; await renderBlank(); }
    if (change === 'unmount') await act(async () => root.render(null));
    if (change === 'owner-switch') setMobileAuthOwner('other');
    await act(async () => ready());
    await notify();
    expect(outbox.find).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  },
);

it('uses the latest device after a route change while storage is pending', async () => {
  await renderBlank();
  resume = { ...resume, deviceId: 'other-device' };
  outbox.records[0].deviceId = 'other-device';
  await renderBlank();
  await act(async () => ready());
  expect(outbox.find).toHaveBeenCalledExactlyOnceWith('other-device', '/repo');
  expect(container.textContent).toBe('other-device/task');
  await act(async () => root.render(null));
  expect(outbox.listeners.size).toBe(0);
});

// Cold recovery now waits for queued messages to join the draft. That await
// must not restore stale content, swallow a write failure, or claim twice.
it.each(['complete', 'unmount', 'owner-switch', 'save-fails', 'prepared'] as const)(
  'settles follow-up consolidation before restoring the editor: %s', async outcome => {
    let resolve!: (record: DurableOutboxRecord) => void;
    let reject!: (error: Error) => void;
    outbox.merge.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    edit.onError = vi.fn();
    await renderEdit();
    await act(async () => ready());
    await notify();
    expect(outbox.merge).toHaveBeenCalledOnce();
    expect(outbox.claim).not.toHaveBeenCalled();
    if (outcome === 'unmount') await act(async () => root.render(null));
    if (outcome === 'owner-switch') setMobileAuthOwner('other');
    if (outcome === 'prepared') outbox.records[0].prepared = {} as NonNullable<DurableOutboxRecord['prepared']>;
    await act(async () => {
      if (outcome === 'save-fails') reject(new Error('save failed'));
      else resolve(outbox.records[0]);
    });
    expect(outbox.claim).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
    expect(edit.onError).toHaveBeenCalledTimes(outcome === 'save-fails' ? 1 : 0);
    if (outcome === 'complete') expect(container.textContent).toContain('Saved draft');
    else expect(container.textContent).not.toContain('Saved draft');
  },
);
