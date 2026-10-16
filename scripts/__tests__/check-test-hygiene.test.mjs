// Contract for scripts/check-test-hygiene.mjs: each case is the smallest source
// that flips one rule decision, so a detector regression cannot silently let
// slow or source-literal unit tests back into CI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	compareWithBaseline,
	scanRepository,
	scanTestSource,
	TEST_FILE,
} from "../check-test-hygiene.mjs";

test("hygiene scans both test and spec files", () => {
	assert.equal(TEST_FILE.test("src/example.test.ts"), true);
	assert.equal(TEST_FILE.test("src/example.spec.tsx"), true);
	assert.equal(TEST_FILE.test("src/example.test.js"), true);
	assert.equal(TEST_FILE.test("src/example.spec.cjs"), true);
	assert.equal(TEST_FILE.test("src/example.integration.spec.ts"), true);
	assert.equal(TEST_FILE.test("src/example.ts"), false);
});

test("scanTestSource counts only unjustified hits for each rule", () => {
	const cases = [
		["per-test module reset", "beforeEach(() => { vi.resetModules(); });", { resetModules: 1 }],
		[
			"a reason cannot exempt a per-test hook",
			"beforeEach(() => {\n// reset-modules: cached state\nvi.resetModules();\n});",
			{ resetModules: 1 },
		],
		[
			"a reason cannot exempt a transitive per-test helper",
			"function reload() {\n// reset-modules: cached state\nvi.resetModules();\n}\nconst prepare = () => reload(); beforeEach(prepare);",
			{ resetModules: 1 },
		],
		[
			"same-named helpers in sibling suites keep their own lexical binding",
			"describe('reload', () => { function setup() {\n// reset-modules: cached state\nvi.resetModules();\n} beforeEach(setup); }); describe('other', () => { function setup() {} beforeEach(setup); });",
			{ resetModules: 1 },
		],
		[
			"registering a restart callback does not execute it in the hook",
			"let restart; beforeEach(() => { restart = () => {\n// reset-modules: persisted state after restart\nvi.resetModules();\n}; }); it('restart', () => restart());",
			{ resetModules: 0 },
		],
		[
			"explicit restart boundaries remain exempt",
			"function restart() {\n// reset-modules: verify persisted state after restart\nvi.resetModules();\n}\nit('restart', () => restart());",
			{ resetModules: 0 },
		],
		[
			"justified module reset",
			"// reset-modules: auto-sync prefs are module-scoped\nvi.resetModules();",
			{ resetModules: 0 },
		],
		["commented-out reset", "// vi.resetModules();", { resetModules: 0 }],
		["real 250ms wait", "await new Promise((r) => setTimeout(r, 250));", { realWaits: 1 }],
		["short wait", "await new Promise((r) => setTimeout(r, 20));", { realWaits: 0 }],
		["local timeout wrapper", "const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms)); await tick(2_100);", { realWaits: 1 }],
		["constant timeout duration", "const SECOND = 1000; const timeout = 2 * SECOND; setTimeout(done, timeout);", { realWaits: 1 }],
		["generic arrow in a ts file does not hide later waits", "const identity = <T>(value: T) => value; setTimeout(done, 200);", { realWaits: 1 }],
		["property timeout keeps existing detection", "globalThis.setTimeout(done, 200);", { realWaits: 1 }],
		["short wrapper and fixture shadow", "const tick = ms => new Promise(resolve => setTimeout(resolve, ms)); tick(20); function other(tick) { tick(500); }", { realWaits: 0 }],
		["fake wrapper call", "const tick = ms => new Promise(resolve => setTimeout(resolve, ms)); it('fake', () => { vi.useFakeTimers(); tick(500); });", { realWaits: 0 }],
		["an uncalled fake-timer helper does not hide real waits", "function enableFake() { vi.useFakeTimers(); } it('real', () => setTimeout(done, 200));", { realWaits: 1 }],
		["an uncalled real-timer helper does not restore fake timers", "vi.useFakeTimers(); function cleanup() { vi.useRealTimers(); } it('fake', () => setTimeout(done, 200));", { realWaits: 0 }],
		["a called fake-timer helper applies at the call site", "function enableFake() { vi.useFakeTimers(); } it('fake', () => { enableFake(); setTimeout(done, 200); });", { realWaits: 0 }],
		["a called real-timer helper applies at the call site", "vi.useFakeTimers(); const cleanup = () => vi.useRealTimers(); it('real', () => { cleanup(); setTimeout(done, 200); });", { realWaits: 1 }],
		["a registered timer helper applies as a hook", "function enableFake() { vi.useFakeTimers(); } beforeEach(enableFake); it('fake', () => setTimeout(done, 200));", { realWaits: 0 }],
		["transitive timer helper calls preserve their order", "function fake() { vi.useFakeTimers(); } const setup = () => { fake(); vi.useRealTimers(); }; it('real', () => { setup(); setTimeout(done, 200); });", { realWaits: 1 }],
		["inline Promise executors inherit test hooks", "beforeEach(() => vi.useFakeTimers()); it('fake', async () => { await new Promise(resolve => setTimeout(resolve, 200)); });", { realWaits: 0 }],
		[
			"fake-timer file",
			"vi.useFakeTimers();\nsetTimeout(tick, 5_000);",
			{ realWaits: 0 },
		],
		[
			"real wait after fake timers are restored",
			"vi.useFakeTimers();\nvi.useRealTimers();\nsetTimeout(tick, 5_000);",
			{ realWaits: 1 },
		],
		[
			"fake timers in a sibling test do not hide a real wait after cleanup",
			"afterEach(() => vi.useRealTimers());\nit('fake', () => { vi.useFakeTimers(); setTimeout(done, 100); });\nit('real', () => { setTimeout(done, 100); });",
			{ realWaits: 1 },
		],
		[
			"afterEach invalidates file registration-time fake timers for later tests",
			"vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => {}); it('later', () => setTimeout(done, 100));",
			{ realWaits: 1 },
		],
		["afterEach does not precede the first test", "vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => setTimeout(done, 100));", { realWaits: 0 }],
		["afterEach restores timers only for subsequent tests", "vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => setTimeout(done, 100)); it('second', () => setTimeout(done, 100));", { realWaits: 1 }],
		[
			"afterEach invalidates describe registration-time fake timers for later tests",
			"describe('timers', () => { vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); it('first', () => {}); it('later', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"beforeEach fake timers apply to their own describe, not a sibling suite",
			"describe('fake', () => { beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers()); it('one', () => setTimeout(done, 100)); });\ndescribe('real', () => { it('two', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"parent beforeEach runs after nested beforeAll",
			"beforeEach(() => vi.useRealTimers()); describe('child', () => { beforeAll(() => vi.useFakeTimers()); it('real', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"global afterEach applies between sibling suites",
			"vi.useFakeTimers(); afterEach(() => vi.useRealTimers()); describe('one', () => { it('first', () => {}); }); describe('two', () => { it('second', () => setTimeout(done, 100)); });",
			{ realWaits: 1 },
		],
		[
			"new nested beforeAll runs after an earlier parent test",
			"afterEach(() => vi.useRealTimers()); it('parent', () => {}); describe('child', () => { beforeAll(() => vi.useFakeTimers()); it('first child', () => setTimeout(done, 100)); });",
			{ realWaits: 0 },
		],
		[
			"multi-line real wait",
			"await new Promise((resolve) => setTimeout(\n  resolve,\n  250,\n));",
			{ realWaits: 1 },
		],
		[
			"source text in fixture string is not executable",
			"expect(output).toContain('vi.resetModules()'); expect(output).toContain('setTimeout(done, 500)');",
			{ resetModules: 0, realWaits: 0 },
		],
		[
			"source text read",
			"const src = readFileSync(resolve(__dirname, '..', 'Sidebar.tsx'), 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"multi-line source text read",
			"const src = readFileSync(\n  resolve(__dirname, '..', 'Sidebar.tsx'),\n  'utf8',\n);",
			{ sourceReads: 1 },
		],
		[
			"import specifiers are not reads",
			"import { x } from '../x.ts';\nvi.mock('../y.ts');\nreadFileSync(join(__dirname, 'fixtures', 'a.ts'));",
			{ sourceReads: 0 },
		],
		...['swift', 'm', 'mm', 'h', 'cpp', 'rs', 'go', 'kt', 'java', 'cs', 'py'].map(extension => [
			`native and other production source: ${extension}`,
			`const source = readFileSync(new URL('../helper.${extension}', import.meta.url), 'utf8');`,
			{ sourceReads: 1 },
		]),
		[
			"data and binary resources are not production source",
			"readFileSync(new URL('../data.json', import.meta.url)); readFileSync(new URL('../helper.bin', import.meta.url));",
			{ sourceReads: 0 },
		],
		["workspace cwd source", "readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8');", { sourceReads: 1 }],
		["cwd fixture stays test data", "readFileSync(resolve(process.cwd(), 'fixtures/helper.ts'), 'utf8');", { sourceReads: 0 }],
		["executed source is a behavior harness", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const run = new Function(source); expect(run()).toBe(true);", { sourceReads: 0 }],
		["a local factory returns executed behavior", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function make(code) { return new Function(code); } const run = make(source); expect(run()).toBe(true);", { sourceReads: 0 }],
		["matchAll destructuring executes captured production code", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const matches = [...source.matchAll(/return (.*);/g)]; for (const [, code] of matches) { const run = new Function(code); expect(run()).toBe(true); }", { sourceReads: 0 }],
		["matchAll execution keeps a mixed text assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); for (const [, code] of source.matchAll(/return (.*);/g)) { new Function(code)(); expect(code).toContain('true'); }", { sourceReads: 1 }],
		["local geometry helpers return evaluated values rather than AST arguments", "const ast = ts.createSourceFile('x.ts', readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8')); function styles(file) { const value = new Function(file.getText())(); return Object.assign({}, value); } expect(styles(ast)).toEqual({ gap: 16 });", { sourceReads: 0 }],
		["a factory with a raw text return branch stays a source assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function make(code, raw) { if (raw) return code; return new Function(code)(); } expect(make(source, true)).toContain('return true');", { sourceReads: 1 }],
		["execution cannot exempt a mixed text assertion", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(source).toContain('return true');", { sourceReads: 1 }],
		["node assertion cannot be hidden by execution", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); assert.match(source, /return true/);", { sourceReads: 1 }],
		["nested node assertion cannot be hidden by execution", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); assert.strict.match(source, /return true/);", { sourceReads: 1 }],
		["unrelated execution does not exempt source text", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function('return true')(); expect(source).toContain('return true');", { sourceReads: 1 }],
		["object property names do not alias a source binding", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(render({ source: 'content' }).props).toEqual({ active: true });", { sourceReads: 0 }],
		["member names do not alias a source binding", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect(result.source).toBe('content');", { sourceReads: 0 }],
		["shorthand properties keep their source dependency", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect({ source }).toEqual({});", { sourceReads: 1 }],
		["computed property names keep their source dependency", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); new Function(source)(); expect({ [source]: true }).toEqual({});", { sourceReads: 1 }],
		["vm harness follows the actual read binding", "import vm from 'node:vm'; const sourcePath = resolve(process.cwd(), 'src/helper.ts'); const source = readFileSync(sourcePath, 'utf8'); vm.runInNewContext(source, context);", { sourceReads: 0 }],
		["a vm namespace alias executes the actual read", "import * as evaluator from 'node:vm'; const vm = evaluator; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(vm.runInNewContext(source, context)).toBe(true);", { sourceReads: 0 }],
		["a local vm object cannot exempt text assertions", "const vm = { runInNewContext: code => code }; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(vm.runInNewContext(source)).toContain('return true');", { sourceReads: 1 }],
		["a local vm parameter shadows a real vm import", "import vm from 'node:vm'; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function check(vm) { expect(vm.runInNewContext(source)).toContain('return true'); } check({ runInNewContext: code => code });", { sourceReads: 1 }],
		["named vm import executes the actual read", "import { runInNewContext as evaluate } from 'node:vm'; const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); expect(evaluate(source, context)).toBe(true);", { sourceReads: 0 }],
		["a local vm-shaped helper cannot exempt text assertions", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); function runInNewContext(code) { return code; } expect(runInNewContext(source)).toContain('return true');", { sourceReads: 1 }],
		["a shadowed Function cannot exempt text assertions", "const source = readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8'); const Function = code => code; expect(new Function(source)).toContain('return true');", { sourceReads: 1 }],
		["AST extraction executes the source callback", "const source = ts.createSourceFile('x.ts', readFileSync(resolve(process.cwd(), 'src/helper.ts'), 'utf8')); let expression; function visit(node) { expression = node.body; } visit(source); const compiled = ts.transpileModule(expression.getText(source)).outputText; const run = new Function(compiled); expect(run()).toBe(true);", { sourceReads: 0 }],
		[
			"multi-line source path declared before the read",
			"const sourcePath = resolve(\n  __dirname,\n  '..',\n  'Image.tsx',\n);\nconst source = readFileSync(sourcePath, 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"a separately executed test script is not a source read",
			"const script = join(\n dirname(fileURLToPath(import.meta.url)),\n '../scripts/test-share.mjs',\n);\nspawnSync(process.execPath, [script]);\nreadFileSync(template, 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"inline executable paths are not source reads",
			"const installer = resolve(__dirname, '../install.sh'); spawnSync('bash', [resolve(__dirname, '../register.sh')]); readFileSync(logPath, 'utf8');",
			{ sourceReads: 0 },
		],
		[
			"a multi-line native source URL is read through its binding",
			"const sourceUrl = new URL(\n '../helper.swift',\n import.meta.url,\n); const source = readFileSync(sourceUrl, 'utf8');",
			{ sourceReads: 1 },
		],
		[
			"source read through a typed helper",
			"const read = (relative: string): string => readFileSync(resolve(__dirname, relative), 'utf8');\nconst source = read('../ChatInput.tsx');",
			{ sourceReads: 1 },
		],
		[
			"source read through a typed function",
			"function read(relative: string): string { return readFileSync(resolve(__dirname, relative), 'utf8'); }\nconst source = read('../ChatInput.tsx');",
			{ sourceReads: 1 },
		],
	];
	for (const [name, source, expected] of cases) {
		const result = scanTestSource(source);
		for (const [rule, count] of Object.entries(expected)) {
			assert.equal(result[rule], count, `${name}: ${rule}`);
		}
	}
	assert.equal(
		scanTestSource("readFileSync(resolve(__dirname, '../A.tsx'))", { isGuard: true }).sourceReads,
		0,
		"guard-tier files may read source",
	);
});

test("repository scan covers runner performance without rejecting its source contracts", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cindy-hygiene-scan-"));
	try {
		fs.mkdirSync(path.join(root, "scripts", "__tests__"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "test-workspaces.config.mjs"), "export default { workspaces: [] };");
		fs.writeFileSync(path.join(root, "scripts", "__tests__", "runner.test.mjs"),
			"vi.resetModules(); setTimeout(done, 100); readFileSync(resolve(__dirname, '../runner.mjs'));");
		assert.deepEqual(await scanRepository(root), {
			"scripts/__tests__/runner.test.mjs": { resetModules: 1, realWaits: 1, sourceReads: 0 },
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("compareWithBaseline only lets counts stay or shrink", () => {
	const baseline = { "a.test.ts": { resetModules: 2 } };
	const pass = compareWithBaseline(
		{ "a.test.ts": { resetModules: 1, realWaits: 0, sourceReads: 0 } },
		baseline,
	);
	assert.deepEqual(pass.violations, []);
	assert.deepEqual(pass.tightenable, ["a.test.ts"]);

	const fail = compareWithBaseline(
		{
			"a.test.ts": { resetModules: 3, realWaits: 0, sourceReads: 0 },
			"new.test.ts": { resetModules: 0, realWaits: 1, sourceReads: 0 },
		},
		baseline,
	);
	assert.deepEqual(
		fail.violations.map((v) => `${v.file}:${v.rule}:${v.limit}`),
		["a.test.ts:resetModules:2", "new.test.ts:realWaits:0"],
	);
});
