import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the production memo, leaving renderer builders at the test boundary.
// A ready remote view must not parse the unused full raw transcript first.
const source = ts.createSourceFile('MessageStream.tsx', readFileSync(resolve(process.cwd(),
  'src/renderer/components/chat/MessageStream.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
    && node.name.elements.some(element => element.name.getText(source) === 'ungroupedRenderItems')
    && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Missing production history projection');
const code = ts.transpileModule(`return (${callback.getText(source)})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it.each([false, true])('builds only the displayed history source (ready=%s)', ready => {
  const rawItems = [{ key: 'raw' }];
  const historyItems = [{ key: 'history' }];
  const buildRaw = vi.fn(() => ({ items: rawItems, singleResultMap: new Map() }));
  const buildChunk = vi.fn(() => ({ items: historyItems, singleResultMap: new Map([['tool', 'result']]) }));
  const buildHistory = vi.fn(({ build }: { build: (rows: unknown[]) => unknown }) => build([]));
  const bindings = {
    streamProjection: (_rows: unknown, _dependencies: unknown, build: () => unknown) => build(),
    buildCachedRenderItems: buildRaw, buildRenderItems: buildChunk, renderHistoryView: buildHistory,
    getDataOwnerGeneration: () => 1, displayMessages: [], taskUpdates: new Map(), ghostCardSnapshot: {},
    historyLoaded: true, hasMoreMessages: false, historyWindowHasIsland: false, turnChangeSets: [], workingDir: '/',
    simplifiedBotConversation: false, sessionId: 's', cindyMakeSessionId: null, cindyMakeCompletionInComposer: false,
    subagentRunStatuses: new Map(), historyView: {}, historySnapshot: { ready }, historyLiveMessages: [],
    isSessionStreaming: false, handoff: {}, markdownImageTargetCacheRef: { current: new Map() },
    generatedFilesItemCacheRef: { current: new Map() }, groupWorkRuns: (items: unknown) => items,
    reuseGeneratedFilesRenderItems: (items: unknown) => items,
  };
  const result = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  expect(result.items).toEqual(ready ? historyItems : rawItems);
  expect(buildRaw).toHaveBeenCalledTimes(ready ? 0 : 1);
  expect(buildHistory).toHaveBeenCalledTimes(ready ? 1 : 0);
  expect(buildChunk).toHaveBeenCalledTimes(ready ? 1 : 0);
  if (ready) expect(result.singleResultMap.get('tool')).toBe('result');
});
