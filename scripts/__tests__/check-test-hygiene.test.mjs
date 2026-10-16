// Contract for scripts/check-test-hygiene.mjs: each case is the smallest source
// that flips one rule decision, so a detector regression cannot silently let
// slow or source-literal unit tests back into CI.
import assert from "node:assert/strict";
import test from "node:test";

import {
	compareWithBaseline,
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
			"justified module reset",
			"// reset-modules: auto-sync prefs are module-scoped\nvi.resetModules();",
			{ resetModules: 0 },
		],
		["commented-out reset", "// vi.resetModules();", { resetModules: 0 }],
		["real 250ms wait", "await new Promise((r) => setTimeout(r, 250));", { realWaits: 1 }],
		["short wait", "await new Promise((r) => setTimeout(r, 20));", { realWaits: 0 }],
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
