import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Guard tier (engineering-conventions §3.2): the long-lived sidebar owns the
// worker notification subscription. Moving it into the conditional ExpandedView
// loses completion/error notifications while collapsed. Hook behavior is tested
// by useWorkers.test.tsx; no isolated root-sidebar runtime harness exists, and
// mocking its expanded subtree would hide this mount-ownership regression.
it('owns worker attention in the sidebar root across collapsed-view unmounts', () => {
  const source = readFileSync(resolve(__dirname, '../features/cc-agent/CCAgentSidebarUpper.tsx'), 'utf8');
  const start = source.indexOf('export function CCAgentSidebarUpper()');
  const end = source.indexOf('function ExpandedView(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(source.slice(start, end)).toContain('useOrcaWorkerAttentionWatcher(sessionsHook.sessions, activeSessionId);');
  expect(source.slice(end)).not.toContain('useOrcaWorkerAttentionWatcher(');
});
