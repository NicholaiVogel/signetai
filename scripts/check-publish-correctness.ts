#!/usr/bin/env bun
/**
 * check-publish-correctness.ts — run `publint` and `@arethetypeswrong/cli`
 * against every publishable workspace package (any package.json with a
 * "publishConfig" field, excluding node_modules/dist build output dirs and
 * references/). Used by .github/workflows/ci.yml (issue #919).
 *
 * Usage:
 *   bun scripts/check-publish-correctness.ts publint
 *   bun scripts/check-publish-correctness.ts attw
 *   bun scripts/check-publish-correctness.ts all
 */
import { $, Glob } from "bun";

const mode = process.argv[2] ?? "all";
if (!["publint", "attw", "all"].includes(mode)) {
	console.error(`unknown mode: ${mode}`);
	process.exit(2);
}

const SKIP = /node_modules|references\/|\/dist\/|\.svelte-kit/;
const packages: string[] = [];
for await (const path of new Glob("**/package.json").scan({ cwd: process.cwd(), absolute: false })) {
	if (SKIP.test(path)) continue;
	const pkg = await Bun.file(path).json();
	if (pkg.publishConfig) packages.push(path.replace(/\/package\.json$/, ""));
}
packages.sort();

if (packages.length === 0) {
	console.error("no publishable packages found");
	process.exit(2);
}
console.log(`publishable packages (${packages.length}):`);
for (const p of packages) console.log(`  - ${p}`);

let failed = false;
for (const dir of packages) {
	if (mode === "publint" || mode === "all") {
		console.log(`\n== publint: ${dir}`);
		const r = await $`bunx publint ${dir}`.nothrow().quiet();
		if (r.exitCode !== 0) {
			failed = true;
			console.error(r.stderr.toString() || r.stdout.toString());
		}
	}
	if (mode === "attw" || mode === "all") {
		console.log(`\n== attw: ${dir}`);
		const r = await $`bunx @arethetypeswrong/cli --pack ${dir} --format table`.nothrow().quiet();
		if (r.exitCode !== 0) {
			failed = true;
			console.error(r.stderr.toString() || r.stdout.toString());
		}
	}
}
if (failed) {
	console.error("\npublish-correctness check FAILED");
	process.exit(1);
}
console.log("\npublish-correctness check passed");
