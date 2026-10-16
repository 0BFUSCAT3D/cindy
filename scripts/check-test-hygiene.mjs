#!/usr/bin/env node
// check-test-hygiene.mjs — 单测性能与价值的静态门禁（engineering-conventions.md §3.2）。
//
// 跑：node scripts/check-test-hygiene.mjs            检查（CI 阻断）
//     node scripts/check-test-hygiene.mjs --update   把基线收紧到当前计数（只降不升）
//
// 三条规则都只看源码文本，结果与机器快慢无关：
//   reset-modules  每次 vi.resetModules() 都会让后续 import 重新求值整条模块链。
//                  codexProxyHost.test.ts 逐用例重置时 285 条用例耗时 105s，不重置只要 7s。
//                  新增调用必须在上一行写 `// reset-modules: <被隔离的模块状态>`。
//                  beforeEach/afterEach 及其准备、清理 helper 不接受理由豁免。
//   real-wait      单测里 ≥100ms 的真实 setTimeout / sleep 既拖慢 CI 又制造时序抖动；
//                  改用 vi.useFakeTimers() 或等待真实事件。确需真实等待时上一行写
//                  `// real-wait: <原因>`。已切换为 fake timers 的区间不计。
//   source-read    普通单测读取生产源码文本做字面量断言。这类静态契约只能进对应包的
//                  guard tier（scripts/test-workspaces.config.mjs），不接受理由豁免。
//
// 存量计数记在 scripts/test-hygiene-baseline.json，只允许减少：某文件的计数超过基线、
// 或基线外的文件出现未豁免的命中，都会失败。`--update` 只会把基线往下收紧；确需放宽
// 只能手改 JSON，让评审在 diff 里看见。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'test-hygiene-baseline.json');
const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.vite', '.expo', '.turbo']);
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NON_UNIT_TEST = /(?:^|[-.])(?:integration|e2e|git-integration)\.(?:test|spec)\.|\.bench\./;
export const RULES = ['resetModules', 'realWaits', 'sourceReads'];
const REAL_WAIT_MIN_MS = 100;
const REAL_WAIT_PATTERN = /\b(?:sleep|delay|wait|waitMs|pause)\s*\(\s*(\d[\d_]*)\s*\)/g;
// Reuse Desktop's declared parser to locate test/hook callbacks and local helpers.
// No type checking or module loading is needed.
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
let typescript;

/** Replace comments with spaces (keeping newlines) so matches ignore commented-out code. */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  let line = 0;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** True when the closest non-blank line above `line` carries `// <marker>: <reason>`. */
function hasJustification(lines, line, marker) {
  for (let i = line - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (text === '') continue;
    return new RegExp(`//\\s*${marker}:\\s*\\S`).test(text);
  }
  return false;
}

/** A per-test hook cannot turn repeated module loading into an exemption. */
function countModuleResets(code, lines) {
  const resets = [...code.matchAll(/\bvi\.resetModules\s*\(/g)];
  if (resets.length === 0) return 0;
  const ts = typescript ??= requireDesktop('typescript');
  const source = ts.createSourceFile('test.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const nodeScopes = new WeakMap();
  const hooks = [];
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  function collect(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node)) {
      scope = { parent: scope, bindings: new Map() };
    }
    nodeScopes.set(node, scope);
    if (isFunction(node)) {
      if (node.name) scope.bindings.set(node.name.text, node);
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) scope.bindings.set(parameter.name.text, null);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      scope.bindings.set(node.name.text, node.initializer && isFunction(node.initializer) ? node.initializer : null);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && /^(?:beforeEach|afterEach)$/.test(node.expression.text)) hooks.push(...node.arguments);
    ts.forEachChild(node, child => collect(child, scope));
  }
  collect(source, null);
  function resolveHelper(identifier) {
    for (let scope = nodeScopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  const perTest = new Set();
  const visitedFunctions = new Set();
  function visitFunction(node) {
    if (!node || visitedFunctions.has(node)) return;
    visitedFunctions.add(node);
    if (node.body) visit(node.body);
  }
  function visit(node) {
    // Defining or storing a restart callback is not a per-test reload. Only
    // follow an actual local call, or the callback registered with a hook.
    if (isFunction(node)) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'vi' && expression.name.text === 'resetModules') {
        perTest.add(expression.getStart(source));
      }
      if (ts.isIdentifier(expression)) visitFunction(resolveHelper(expression));
      else if (isFunction(expression)) visitFunction(expression);
    }
    ts.forEachChild(node, visit);
  }
  for (const hook of hooks) {
    if (isFunction(hook)) visitFunction(hook);
    else if (ts.isIdentifier(hook)) visitFunction(resolveHelper(hook));
  }
  return resets.filter(match => perTest.has(match.index)
    || !hasJustification(lines, lineOf(code, match.index), 'reset-modules')).length;
}

/** Mask string contents while preserving line numbers and call-site punctuation. */
function maskStrings(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
        out += ch === '\n' ? '\n' : ' ';
      } else if (ch === '\\') {
        escaped = true;
        out += ' ';
      } else if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) {
      quote = ch;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function setTimeoutCalls(code) {
  const calls = [];
  for (const match of code.matchAll(/\bsetTimeout\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let escaped = false;
    const commas = [];
    let end = -1;
    for (let i = start; i < code.length; i += 1) {
      const ch = code[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (ch === ')' && depth === 0) {
          end = i;
          break;
        }
      } else if (ch === ',' && depth === 1) commas.push(i);
    }
    if (end < 0 || commas.length === 0) continue;
    const durationStart = commas[0] + 1;
    const durationEnd = commas[1] ?? end;
    const duration = code.slice(durationStart, durationEnd).trim();
    if (/^\d[\d_]*$/.test(duration)) calls.push({ index: match.index, duration });
  }
  return calls;
}

function timerScopes(code) {
  const ts = typescript ??= requireDesktop('typescript');
  const source = ts.createSourceFile('test.tsx', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const scopes = [];
  function rootName(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) return rootName(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return rootName(expression.tag);
    return '';
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const kind = rootName(node.expression);
      if (/^(?:describe|it|test|beforeEach|beforeAll|afterEach|afterAll)$/.test(kind)) {
        for (const argument of node.arguments) {
          if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
            scopes.push({ kind, start: argument.getStart(source), end: argument.end });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return scopes.sort((a, b) => (a.end - a.start) - (b.end - b.start));
}

function timerStateAt(index, timerEvents, scopes) {
  const scopeAt = (position) => scopes.find(s => s.start <= position && position < s.end);
  const waitScope = scopeAt(index);
  const describeAt = (scope) => scopes.find(s => s.kind === 'describe' && s.start < scope.start && scope.end < s.end);
  const belongsToWait = (scope) => !scope || scope.kind === 'describe' && scope.start < index && index < scope.end;
  const events = timerEvents.map(event => ({ event, scope: scopeAt(event.index) }));
  let fake = false;
  // Registration-time calls and before hooks are distinct from calls in a
  // sibling test or an after hook. Inherit hooks from outer describes first.
  const inherited = events.filter(({ event, scope }) => event.index < index && belongsToWait(scope));
  for (const { event } of inherited) fake = event[1] === 'useFakeTimers';
  if (waitScope && /^(?:it|test)$/.test(waitScope.kind)) {
    // Registration-time setup, like beforeAll, runs only once. An afterEach
    // restoring real timers can invalidate it before a later test runs.
    const restoresRealTimers = events.some(entry => entry.scope?.kind === 'afterEach' && entry.event[1] === 'useRealTimers' && belongsToWait(describeAt(entry.scope)));
    if (restoresRealTimers) fake = false;
    const hooks = events.filter(({ scope }) => scope && /^(?:beforeAll|beforeEach)$/.test(scope.kind) && belongsToWait(describeAt(scope)))
      .sort((a, b) => {
        const depthA = scopes.filter(s => s.kind === 'describe' && s.start < a.scope.start && a.scope.end < s.end).length;
        const depthB = scopes.filter(s => s.kind === 'describe' && s.start < b.scope.start && b.scope.end < s.end).length;
        if (a.scope.kind !== b.scope.kind) return a.scope.kind === 'beforeAll' ? -1 : 1;
        return depthA - depthB || a.event.index - b.event.index;
      });
    for (const { event, scope } of hooks) {
      // An afterEach restoring real timers invalidates beforeAll-only setup
      // for subsequent tests. Be conservative rather than exempt a real wait.
      if (scope.kind === 'beforeAll' && restoresRealTimers) continue;
      fake = event[1] === 'useFakeTimers';
    }
  }
  for (const { event, scope } of events) {
    if (scope === waitScope && event.index < index) fake = event[1] === 'useFakeTimers';
  }
  return fake;
}

function countRealWaits(code, lines) {
  const timerEvents = [...code.matchAll(/\bvi\.(useFakeTimers|useRealTimers)\s*\(/g)];
  const scopes = timerEvents.length > 0 ? timerScopes(code) : [];
  let count = 0;
  const waits = [
    ...setTimeoutCalls(code).map(({ index, duration }) => ({ index, duration })),
    ...[...code.matchAll(REAL_WAIT_PATTERN)].map((match) => ({
      index: match.index,
      duration: match[1] ?? match[2],
    })),
  ].sort((a, b) => a.index - b.index);
  for (const wait of waits) {
    if (timerStateAt(wait.index, timerEvents, scopes)) continue;
    if (Number(wait.duration.replaceAll('_', '')) < REAL_WAIT_MIN_MS) continue;
    const line = lineOf(code, wait.index);
    if (!hasJustification(lines, line, 'real-wait')) count += 1;
  }
  return count;
}

const IMPORT_CONTEXT = /(?:\bfrom|\bimport|\brequire|\.mock|\.doMock|\.unmock|\.importActual|\.importMock|\.glob)\s*\(?\s*$/;
const SOURCE_EXTENSION = '(?:tsx?|mts|cts|css|mjs|cjs|jsx?|swift|[cmh]|mm|cc|cpp|cxx|hh|hpp|hxx|rs|go|kts?|java|cs|py|rb|sh|bash|zsh|html|vue|svelte|scss|sass|less)';
const SOURCE_EXT = new RegExp('\\.' + SOURCE_EXTENSION + '$', 'i');
const SOURCE_LITERAL = new RegExp('\\.' + SOURCE_EXTENSION + '[\'"]', 'i');
// Only anchors that point into the checkout count; generic names such as `root`
// usually hold an mkdtemp() directory whose fake source files are test input.
const REPO_ANCHOR = /__dirname|import\.meta\.(?:url|dirname)|\b(?:REPO_ROOT|repoRoot|desktopRoot)\b/;

function findEnclosingReadCall(code, index, pattern = /\breadFile(?:Sync)?\s*\(/g) {
  const starts = [...code.matchAll(pattern)];
  for (let n = starts.length - 1; n >= 0; n -= 1) {
    const start = starts[n].index;
    if (start == null || start >= index) continue;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (let i = start + starts[n][0].length; i < index; i += 1) {
      const ch = code[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth > 0) return start;
  }
  return -1;
}

function findSourceReadHelpers(code) {
  const helpers = new Set();
  const arrowPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=>[^;{}]{0,500}\breadFile(?:Sync)?\s*\(/g;
  for (const match of code.matchAll(arrowPattern)) helpers.add(match[1]);
  const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;\n]+)?\{[^{}]{0,500}\breadFile(?:Sync)?\s*\(/g;
  for (const match of code.matchAll(functionPattern)) helpers.add(match[1]);
  return helpers;
}

function isSourcePathLiteral(code, match, sourceReadHelpers = new Set()) {
  const value = match[2];
  if (!SOURCE_EXT.test(value) || /fixture|:\/\//i.test(value)) return false;
  if (IMPORT_CONTEXT.test(code.slice(Math.max(0, match.index - 24), match.index))) return false;
  const lineStart = code.lastIndexOf('\n', match.index) + 1;
  const lineEnd = code.indexOf('\n', match.index);
  const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  // Test data under a fixtures directory is input, not production source.
  if (/fixture/i.test(line)) return false;
  const prefix = line.slice(0, match.index - lineStart);
  const helperCall = prefix.match(/\b([A-Za-z_$][\w$]*)\s*\(\s*$/)?.[1];
  if (helperCall && sourceReadHelpers.has(helperCall)) return true;
  // resolve(__dirname, '..', 'Sidebar.tsx') or new URL('../x.ts', import.meta.url).
  if (REPO_ANCHOR.test(line) && findEnclosingReadCall(code, match.index) >= 0) return true;
  // A separately declared sourcePath may be formatted over several lines before
  // it is passed to readFileSync. Keep that equivalent to the inline path form.
  const pathStart = findEnclosingReadCall(code, match.index, /\b(?:resolve|join|URL)\s*\(/g);
  if (pathStart >= 0) {
    const pathEnd = code.indexOf(')', match.index + match[0].length);
    const pathContext = code.slice(pathStart, pathEnd < 0 ? match.index + match[0].length : pathEnd + 1);
    const binding = code.slice(Math.max(0, pathStart - 150), pathStart)
      .match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:[A-Za-z_$][\w$]*\.)?$/)?.[1];
    const readBinding = binding && new RegExp('\\breadFile(?:Sync)?\\s*\\(\\s*' + binding + '\\b').test(code);
    if (readBinding && REPO_ANCHOR.test(pathContext) && !/fixture/i.test(pathContext)) return true;
  }
  // Keep the same decision for a formatted multi-line readFileSync call. The
  // current line may only contain the final path segment, while the repository
  // anchor and read call live on the preceding lines.
  const callStart = findEnclosingReadCall(code, match.index);
  if (callStart >= 0) {
    const callContext = code.slice(callStart, match.index + match[0].length);
    const previousContext = callContext.slice(0, -match[0].length);
    const hasPriorSourceLiteral = SOURCE_LITERAL.test(previousContext);
    if (/\n/.test(callContext) && !hasPriorSourceLiteral && !/[;{}]/.test(callContext) && REPO_ANCHOR.test(callContext) && !/fixture/i.test(callContext)) return true;
  }
  // readFileSync('../x.ts') reads relative to the test process, i.e. the checkout.
  return callStart >= 0 && (value.startsWith('./') || value.startsWith('../'));
}

/** Count unjustified rule hits in one unit test file. */
export function scanTestSource(source, { isGuard = false } = {}) {
  const code = stripComments(source);
  const lines = source.split(/\r?\n/);
  const executableCode = maskStrings(code);
  const resetModules = countModuleResets(executableCode, lines);
  const realWaits = countRealWaits(executableCode, lines);
  let sourceReads = 0;
  if (!isGuard && /\breadFileSync\b|\breadFile\s*\(|\?raw/.test(code)) {
    const sourceReadHelpers = findSourceReadHelpers(code);
    for (const match of code.matchAll(/(['"`])([^'"`\n$]+)\1/g)) {
      if (match[2].endsWith('?raw') || isSourcePathLiteral(code, match, sourceReadHelpers)) sourceReads += 1;
    }
  }
  return { resetModules, realWaits, sourceReads };
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), out);
    } else if (TEST_FILE.test(entry.name) && !NON_UNIT_TEST.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

async function loadGuardFiles(root) {
  const configUrl = pathToFileURL(path.join(root, 'scripts', 'test-workspaces.config.mjs'));
  const { default: manifest } = await import(configUrl.href);
  const guard = new Set();
  for (const workspace of manifest.workspaces) {
    for (const file of workspace.tiers?.guard?.include ?? []) {
      guard.add(path.posix.join(workspace.cwd, file));
    }
  }
  return guard;
}

export async function scanRepository(root = ROOT) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) walk(path.join(root, scanRoot), files);
  const guard = await loadGuardFiles(root);
  const counts = {};
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    // Root runner tests are a dedicated infrastructure/contract tier. Their
    // source contracts remain valid; the performance rules still apply.
    const result = scanTestSource(readFileSync(file, 'utf8'), { isGuard: guard.has(rel) || rel.startsWith('scripts/') });
    if (RULES.some((rule) => result[rule] > 0)) counts[rel] = result;
  }
  return counts;
}

/** Compare current counts with the ratchet baseline. */
export function compareWithBaseline(counts, baseline) {
  const violations = [];
  const tightenable = [];
  for (const [file, current] of Object.entries(counts)) {
    const allowed = baseline[file] ?? {};
    for (const rule of RULES) {
      const limit = allowed[rule] ?? 0;
      if (current[rule] > limit) violations.push({ file, rule, current: current[rule], limit });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const current = counts[file] ?? {};
    if (RULES.some((rule) => (current[rule] ?? 0) < (allowed[rule] ?? 0))) tightenable.push(file);
  }
  return { violations, tightenable };
}

const HINTS = {
  resetModules: 'beforeEach/afterEach 及其准备、清理 helper 禁止重载模块，写理由也不豁免；显式重启边界上一行写 `// reset-modules: <原因>`；优先用生产代码的 dispose/reset 或依赖注入',
  realWaits: '改用 vi.useFakeTimers() 或等待真实事件；确需真实等待时上一行写 `// real-wait: <原因>`',
  sourceReads: '普通单测不得读取源码文本做字面量断言；改为经生产入口验证行为，纯跨文件契约移入对应包的 guard tier',
};

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
}

function writeBaseline(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const body = {
    description: 'Ratchet baseline for scripts/check-test-hygiene.mjs. Counts may only go down; see engineering-conventions.md §3.2.',
    files: sorted,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)) {
  const counts = await scanRepository();
  const baseline = readBaseline();
  const { violations, tightenable } = compareWithBaseline(counts, baseline);
  if (args.includes('--update')) {
    // The very first run records the existing debt; afterwards --update only tightens.
    if (violations.length > 0 && existsSync(BASELINE_PATH)) {
      for (const v of violations) console.error(`refusing to raise ${v.rule} for ${v.file}: ${v.limit} -> ${v.current}`);
      console.error('[test-hygiene] --update only tightens the baseline; fix the new hits instead.');
      return 1;
    }
    const next = {};
    for (const [file, current] of Object.entries(counts)) {
      const entry = Object.fromEntries(RULES.filter((rule) => current[rule] > 0).map((rule) => [rule, current[rule]]));
      if (Object.keys(entry).length > 0) next[file] = entry;
    }
    writeBaseline(next);
    console.log(`[test-hygiene] baseline updated: ${Object.keys(next).length} files`);
    return 0;
  }
  if (violations.length === 0) {
    if (tightenable.length > 0) {
      console.error(`[test-hygiene] FAIL — ${tightenable.length} baseline entries can be tightened; run node scripts/check-test-hygiene.mjs --update`);
      return 1;
    }
    console.log(`[test-hygiene] PASS (${Object.keys(counts).length} files within baseline)`);
    return 0;
  }
  for (const v of violations) {
    console.error(`❌ [${v.rule}] ${v.file}: ${v.current} unjustified hit(s), baseline allows ${v.limit}`);
    console.error(`   ${HINTS[v.rule]}`);
  }
  console.error('[test-hygiene] FAIL — see docs/dev-rules/engineering-conventions.md §3.2');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[test-hygiene] ${error.message}`);
    process.exitCode = 2;
  });
}
