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
//   real-wait      单测里 ≥100ms 的真实 setTimeout / sleep 既拖慢 CI 又制造时序抖动；
//                  改用 vi.useFakeTimers() 或等待真实事件。确需真实等待时上一行写
//                  `// real-wait: <原因>`。调用 vi.useFakeTimers() 的文件不计。
//   source-read    普通单测读取生产源码文本做字面量断言。这类静态契约只能进 Desktop
//                  guard tier（scripts/test-workspaces.config.mjs），不接受理由豁免。
//
// 存量计数记在 scripts/test-hygiene-baseline.json，只允许减少：某文件的计数超过基线、
// 或基线外的文件出现未豁免的命中，都会失败。`--update` 只会把基线往下收紧；确需放宽
// 只能手改 JSON，让评审在 diff 里看见。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'test-hygiene-baseline.json');
const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.vite', '.expo', '.turbo']);
export const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs)$/;
const NON_UNIT_TEST = /\.(?:integration|e2e|git-integration)\.(?:test|spec)\.|\.bench\./;
export const RULES = ['resetModules', 'realWaits', 'sourceReads'];
const REAL_WAIT_MIN_MS = 100;
const REAL_WAIT_PATTERN = /\bsetTimeout\s*\([^;\n]*?,\s*(\d[\d_]*)\s*\)|\b(?:sleep|delay|wait|waitMs|pause)\s*\(\s*(\d[\d_]*)\s*\)/g;

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

function countMatches(code, lines, pattern, marker, accept = () => true) {
  let count = 0;
  for (const match of code.matchAll(pattern)) {
    if (!accept(match)) continue;
    if (!hasJustification(lines, lineOf(code, match.index), marker)) count += 1;
  }
  return count;
}

function countRealWaits(code, lines) {
  const timerEvents = [...code.matchAll(/\bvi\.(useFakeTimers|useRealTimers)\s*\(/g)];
  let timerIndex = 0;
  let fakeTimers = false;
  let count = 0;
  for (const match of code.matchAll(REAL_WAIT_PATTERN)) {
    while (timerIndex < timerEvents.length && timerEvents[timerIndex].index < match.index) {
      fakeTimers = timerEvents[timerIndex][1] === 'useFakeTimers';
      timerIndex += 1;
    }
    if (fakeTimers) continue;
    if (Number((match[1] ?? match[2]).replaceAll('_', '')) < REAL_WAIT_MIN_MS) continue;
    const line = lineOf(code, match.index);
    if (!hasJustification(lines, line, 'real-wait')) count += 1;
  }
  return count;
}

const IMPORT_CONTEXT = /(?:\bfrom|\bimport|\brequire|\.mock|\.doMock|\.unmock|\.importActual|\.importMock|\.glob)\s*\(?\s*$/;
const SOURCE_EXT = /\.(?:tsx?|mts|cts|css|mjs|cjs|jsx?)$/;
// Only anchors that point into the checkout count; generic names such as `root`
// usually hold an mkdtemp() directory whose fake source files are test input.
const REPO_ANCHOR = /__dirname|import\.meta\.(?:url|dirname)|\b(?:REPO_ROOT|repoRoot|desktopRoot)\b/;

function findEnclosingReadCall(code, index) {
  const starts = [...code.matchAll(/\breadFile(?:Sync)?\s*\(/g)];
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

function isSourcePathLiteral(code, match) {
  const value = match[2];
  if (!SOURCE_EXT.test(value) || /fixture|:\/\//i.test(value)) return false;
  if (IMPORT_CONTEXT.test(code.slice(Math.max(0, match.index - 24), match.index))) return false;
  const lineStart = code.lastIndexOf('\n', match.index) + 1;
  const lineEnd = code.indexOf('\n', match.index);
  const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  // Test data under a fixtures directory is input, not production source.
  if (/fixture/i.test(line)) return false;
  // resolve(__dirname, '..', 'Sidebar.tsx') or new URL('../x.ts', import.meta.url).
  if (REPO_ANCHOR.test(line)) return true;
  // Keep the same decision for a formatted multi-line readFileSync call. The
  // current line may only contain the final path segment, while the repository
  // anchor and read call live on the preceding lines.
  const callStart = findEnclosingReadCall(code, match.index);
  if (callStart >= 0) {
    const callContext = code.slice(callStart, match.index + match[0].length);
    const previousContext = callContext.slice(0, -match[0].length);
    const hasPriorSourceLiteral = /\.(?:tsx?|mts|cts|css|mjs|cjs|jsx?)['"]/.test(previousContext);
    if (/\n/.test(callContext) && !hasPriorSourceLiteral && !/[;{}]/.test(callContext) && REPO_ANCHOR.test(callContext) && !/fixture/i.test(callContext)) return true;
  }
  // readFileSync('../x.ts') reads relative to the test process, i.e. the checkout.
  return /\breadFile(?:Sync)?\s*\(/.test(line) && (value.startsWith('./') || value.startsWith('../'));
}

/** Count unjustified rule hits in one unit test file. */
export function scanTestSource(source, { isGuard = false } = {}) {
  const code = stripComments(source);
  const lines = source.split(/\r?\n/);
  const resetModules = countMatches(code, lines, /\bvi\.resetModules\s*\(/g, 'reset-modules');
  const realWaits = countRealWaits(code, lines);
  let sourceReads = 0;
  if (!isGuard && /\breadFileSync\b|\breadFile\s*\(|\?raw['"`]/.test(code)) {
    for (const match of code.matchAll(/(['"`])([^'"`\n$]+)\1/g)) {
      if (match[2].endsWith('?raw') || isSourcePathLiteral(code, match)) sourceReads += 1;
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
    const result = scanTestSource(readFileSync(file, 'utf8'), { isGuard: guard.has(rel) });
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
  resetModules: '只在被测的模块级状态确实需要重建的边界调用，上一行写 `// reset-modules: <原因>`；优先用生产代码的 dispose/reset 或依赖注入',
  realWaits: '改用 vi.useFakeTimers() 或等待真实事件；确需真实等待时上一行写 `// real-wait: <原因>`',
  sourceReads: '普通单测不得读取源码文本做字面量断言；改为经生产入口验证行为，纯跨文件契约移入 Desktop guard tier',
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
    console.log(`[test-hygiene] PASS (${Object.keys(counts).length} files within baseline)`);
    if (tightenable.length > 0) {
      console.log(`[test-hygiene] ${tightenable.length} baseline entries can be tightened: node scripts/check-test-hygiene.mjs --update`);
    }
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
