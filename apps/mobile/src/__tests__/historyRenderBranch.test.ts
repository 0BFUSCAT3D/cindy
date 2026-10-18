import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the screen's real memo body with render builders as the boundary.
// Native mounting/timers are irrelevant to whether unused raw history is parsed.
const source = ts.createSourceFile('session.tsx', readFileSync(resolve(process.cwd(),
  'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'renderWindow'
    && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Missing production render window');
const code = ts.transpileModule(`return (${callback.getText(source)})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it.each([false, true])('builds only the displayed history source (ready=%s)', ready => {
  const rawItems = [{ key: 'raw' }];
  const historyItems = [{ key: 'history' }];
  const buildRaw = vi.fn(() => ({ items: rawItems, prefix: null, diffCount: 2 }));
  const buildHistory = vi.fn(() => historyItems);
  const prefixCache = { current: {} as unknown };
  const bindings = {
    buildMobileStreamingRenderWindow: buildRaw, buildMobileHistoryRenderItems: buildHistory,
    i18nInstance: { language: 'en' }, projectedMessages: [], projectedMessageStructureChangedIndexes: [],
    renderMessageStructureToken: {}, inputProjection: {}, optimisticUsers: [], isMessageListStreaming: false,
    makerTurnRunning: false, sessionId: 's', currentSession: {}, streamingRenderPrefixRef: prefixCache,
    taskUpdates: new Map(), historyView: { snapshot: { ready }, view: {} }, handoff: {}, localUserClientIds: new Set(),
    insertMobileForkOriginItem: (items: unknown) => items, forkOrigin: null, errorTailClientId: null,
    previousRenderItemsRef: { current: null }, committedMobileStreamingPrefixItemCount: () => 0,
    reconcileMobileMessageRenderItems: (_previous: unknown, items: unknown) => items,
    countMobileRenderItemDiffs: () => 7,
  };
  const result = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  expect(result.items).toBe(ready ? historyItems : rawItems);
  expect(result.diffCount).toBe(ready ? 7 : 2);
  expect(buildRaw).toHaveBeenCalledTimes(ready ? 0 : 1);
  expect(buildHistory).toHaveBeenCalledTimes(ready ? 1 : 0);
  if (ready) expect(prefixCache.current).toBeNull();
});
