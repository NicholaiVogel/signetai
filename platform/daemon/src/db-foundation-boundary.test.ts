import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("DB foundation dependency invariant", () => {
	it("prevents accessor and vacuum primitives from importing owner orchestration", () => {
		const accessor = source("./db-accessor.ts");
		const vacuum = source("./db-vacuum.ts");

		expect(accessor).not.toContain('from "./db-owner-runtime"');
		expect(accessor).not.toContain('import("./agent-id")');
		expect(accessor).not.toContain('from "./db-vacuum-worker"');
		expect(vacuum).not.toContain('from "./db-owner-runtime"');
	});
});
