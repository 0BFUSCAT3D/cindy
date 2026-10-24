// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { PendingSendBubbleActions } from '@/session/PendingSendBubble';

// Unit regression: execute the page's real callbacks/memo with React. Native
// transport and composer boundaries are substituted, not the callback bodies.
const source = ts.createSourceFile('page.tsx', readFileSync(resolve(process.cwd(),
  'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['findDurableOutboxRecord', 'retryOutboxItem', 'removeOutboxItem',
  'steerQueueItem', 'removeQueueItem', 'beginQueueEdit', 'pendingSendActions'];
const declarations = new Map<string, ts.VariableDeclaration>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
    declarations.set(node.name.getText(source), node);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const code = names.map(name => {
  const node = declarations.get(name);
  if (!node) throw new Error(`Missing production declaration: ${name}`);
  return `const ${node.getText(source)};`;
}).join('\n');

it('retains actions on unrelated renders, but uses current task and edit guards after changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const records = [
    { deviceId: 'pc', state: 'failed', item: { sessionId: 'a', clientId: 'send' } },
    { deviceId: 'pc', state: 'failed', item: { sessionId: 'b', clientId: 'send' } },
  ];
  const setError = vi.fn();
  const update = vi.fn().mockResolvedValue(undefined);
  const bindings = {
    useCallback: React.useCallback, useMemo: React.useMemo, remoteSessionStore,
    deviceId: 'pc', deviceName: 'Computer', router: {},
    getCurrentMobileOutboxRecords: () => records, mobileDurableOutbox: { update },
    setError, formatRemoteError: String, t: (key: string) => key,
    queueSelectedClientId: null, setQueueSelectedClientId: vi.fn(),
    moveQueueItem: vi.fn(), maker: {}, invoke: vi.fn(),
    runQueueAction: vi.fn(), runOptimisticQueueAction: vi.fn(), showTransientNotice: vi.fn(),
    applyComposerDocument: vi.fn(), discardQueueEditTransientAttachments: vi.fn(),
    setQueueEditLock: vi.fn(), queueEditSaveInFlightRef: { current: null },
  };
  const compiled = ts.transpileModule(`return function Probe({ sessionId, queueBusy, pendingUploads, queueAvailabilityReason, capture }) {
    ${code}
    capture(pendingSendActions);
    return null;
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const Probe = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  const root = createRoot(document.createElement('div'));
  let actions!: PendingSendBubbleActions;
  const capture = (value: PendingSendBubbleActions) => { actions = value; };
  const show = (sessionId = 'a', queueBusy = false, pendingUploads: unknown[] = [], queueAvailabilityReason: string | null = null) =>
    act(() => root.render(<Probe {...{ sessionId, queueBusy, pendingUploads, queueAvailabilityReason, capture }} />));
  remoteSessionStore.clear();
  try {
    show();
    const initial = actions;
    for (let n = 0; n < 30; n += 1) show();
    expect(actions).toBe(initial);
    await act(async () => actions.onRetryOutbox?.('send'));
    expect(update).toHaveBeenLastCalledWith(records[0], expect.objectContaining({ state: 'queued' }));
    show('b');
    await act(async () => actions.onRetryOutbox?.('send'));
    expect(update).toHaveBeenLastCalledWith(records[1], expect.objectContaining({ state: 'queued' }));
    remoteSessionStore.setInputProjection('b', {
      ...remoteSessionStore.getInputProjection('b'),
      pendingQueue: [{ clientId: 'queued', text: 'message', persistedContent: 'message',
        model: 'model', workingDir: '/synthetic', createOpts: {}, chatMessage: { role: 'user' } }],
    });
    show('b', false, [{}]);
    actions.onBeginEdit?.('queued');
    expect(setError).toHaveBeenLastCalledWith('session.screen.attachmentsUploadingBeforeEdit');
    setError.mockClear();
    show('b', true, [{}]);
    expect(actions.busy).toBe(true);
    actions.onBeginEdit?.('queued');
    expect(setError).not.toHaveBeenCalled();
    show('b', false, [{}], 'offline');
    actions.onBeginEdit?.('queued');
    expect(setError).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    remoteSessionStore.clear();
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
