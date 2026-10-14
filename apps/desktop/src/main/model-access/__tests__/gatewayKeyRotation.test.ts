import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the production writer with boundary/IO fixtures, without initializing
// Electron or the model catalog. No copied implementation or source assertions.
const source = ts.createSourceFile('index.ts', readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const writer = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'writeXdKeyWithCodexSideEffect')!;
const compiled = ts.transpileModule(writer.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const owner = { scope: 'cloud:account-a:1', pending: false };
  const prepare = vi.fn(async () => {});
  const cancel = vi.fn();
  const finalize = vi.fn(async () => {});
  const write = vi.fn(() => true);
  const notify = vi.fn();
  const context = vm.createContext({
    activeOwnerScopeKey: () => owner.scope,
    isAppSessionBoundaryPending: () => owner.pending,
    prepareCodexForAuthModeChange: prepare,
    cancelCodexAuthModeChange: cancel,
    finalizeCodexAfterAuthModeChange: finalize,
    getProviderSecretStore: () => ({ set: write }),
    notifyXdProviderKeyChanged: notify,
    log: { warn: vi.fn() },
  });
  const rotate = vm.runInContext(`${compiled}\nwriteXdKeyWithCodexSideEffect`, context) as (key: string) => Promise<boolean>;
  return { owner, prepare, cancel, finalize, write, notify, rotate };
}

describe('gateway key rotation writer', () => {
  it('coordinates every gateway host before writing and leaves OAuth state unchanged', async () => {
    const h = harness();
    h.prepare.mockImplementation(async () => { expect(h.write).not.toHaveBeenCalled(); });
    expect(await h.rotate('invalid-test-key')).toBe(true);
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith({ allLocalHosts: true, credentialMode: 'gateway-key' });
    expect(h.write).toHaveBeenCalledExactlyOnceWith('xd', 'invalid-test-key');
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.finalize).toHaveBeenCalledExactlyOnceWith({ refreshAuthState: false });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('does not start a rotation during account handoff', async () => {
    const h = harness();
    h.owner.pending = true;
    expect(await h.rotate('invalid-test-key')).toBe(false);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each(['different-owner', 'same-owner-new-generation', 'handoff-pending'])('discards stale credentials after preparation: %s', async change => {
    const h = harness();
    h.prepare.mockImplementation(async () => {
      if (change === 'different-owner') h.owner.scope = 'cloud:account-b:2';
      if (change === 'same-owner-new-generation') h.owner.scope = 'cloud:account-a:3';
      if (change === 'handoff-pending') h.owner.pending = true;
    });
    expect(await h.rotate('invalid-account-a-key')).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it('preserves the stored key when the target host is busy', async () => {
    const h = harness();
    h.prepare.mockRejectedValue(new Error('busy'));
    expect(await h.rotate('invalid-test-key')).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('releases the guard when credential storage rejects the write', async () => {
    const h = harness();
    h.write.mockReturnValue(false);
    expect(await h.rotate('invalid-test-key')).toBe(false);
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });
});
