// Execute the real page callback: shares can upload before a computer is chosen.
// First/same-host selection must preserve them; a real host switch still discards.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const page = ts.createSourceFile('new.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(page) === 'selectDevice'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    const first = node.initializer.arguments[0];
    if (first && ts.isArrowFunction(first)) callback = first;
  }
  ts.forEachChild(node, visit);
}
visit(page);
if (!callback) throw new Error('Missing actual new-task device selection callback');
const setterNames = [...new Set(callback.getText(page).match(/\bset[A-Z]\w*/g) ?? [])];
const compiled = ts.transpileModule(`const selectDevice = ${callback.getText(page)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, alwaysStrict: false },
}).outputText;
function run(bindings: Record<string, unknown>) {
  const select = new Function(...Object.keys(bindings), `${compiled}; return selectDevice;`)(...Object.values(bindings));
  select({ deviceId: 'new-host', name: 'Fixture' });
}

it.each([['', false], ['new-host', false], ['old-host', true]] as const)(
  'preserves initial shares with previous host %s (discard=%s)', (previous, discard) => {
    const bindings: Record<string, unknown> = {
      creating: false, voiceIsProcessing: false, voiceState: 'idle',
      attachments: [{ id: 'shared-attachment' }], auth: { getAccessToken: vi.fn() },
      selectedDeviceIdRef: { current: previous }, browseSeqRef: { current: 0 },
      composerAnnotationsRef: { current: { forgetAllAttachments: vi.fn() } },
    };
    for (const name of ['voicePermissionRequestInFlightRef', 'voiceStopInFlightRef', 'voiceStartupInFlightRef',
      'voiceRecordingActiveRef', 'userTouchedDeviceRef', 'userTouchedRuntimeRef']) bindings[name] = { current: false };
    for (const name of ['explicitProviderModelSelectionRef', 'autoDefaultDeviceRef', 'initialWorkspaceKeyRef']) bindings[name] = { current: null };
    for (const name of ['cancelVoiceForDeviceSwitch', 'saveNewSessionPreferences', 'discardMobileUploadedAttachment',
      'discardAllPendingUploads', 'releaseUploadedSources']) bindings[name] = vi.fn();
    for (const name of setterNames) bindings[name] = vi.fn();
    run(bindings);
    expect(bindings.discardMobileUploadedAttachment).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(bindings.discardAllPendingUploads).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(bindings.releaseUploadedSources).toHaveBeenCalledTimes(discard ? 1 : 0);
    expect(bindings.selectedDeviceIdRef).toEqual({ current: 'new-host' });
    if (discard) expect(bindings.setAttachments).toHaveBeenCalledWith([]);
    else expect(bindings.setAttachments).not.toHaveBeenCalled();
  },
);
