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
