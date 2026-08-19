import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import { runIncrementalDatabaseIntegrityCheck } from "./incremental-database-integrity";

const resources: Array<{ readonly directory: string; readonly owner: ReturnType<typeof createDbOwnerClient> }> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) {
		await resource.owner.close();
		rmSync(resource.directory, { recursive: true, force: true });
	}
});

function makeDatabase(): {
	readonly directory: string;
	readonly path: string;
	readonly owner: ReturnType<typeof createDbOwnerClient>;
} {
	const directory = mkdtempSync(join(tmpdir(), "incremental-integrity-"));
	const path = join(directory, "memory.db");
	const database = new Database(path);
	database.exec("CREATE TABLE alpha (value TEXT); CREATE TABLE beta (value TEXT); CREATE TABLE gamma (value TEXT);");
	database.close();
	const owner = createDbOwnerClient({ dbPath: path });
	resources.push({ directory, owner });
	return { directory, path, owner };
}

describe("incremental database integrity maintenance (#1683)", () => {
	it("commits one table frontier per bounded slice and resumes", async () => {
		const database = makeDatabase();
		await database.owner.start();

		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.resume",
			tablesPerRun: 1,
			runBudgetMs: 5_000,
		});
		expect(first.phase).toBe("running");
		expect(first.checkedTables).toBe(1);
		expect(first.remainingTables).toBe(2);
		expect(first.lastTable).toBe("alpha");
		expect(first.pagesChecked).toBeGreaterThan(0);
		expect(first.bytesChecked).toBeGreaterThan(0);
		expect(first.memoryRssBytes).toBeGreaterThan(0);

		const second = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.resume",
			tablesPerRun: 2,
			runBudgetMs: 5_000,
		});
		expect(second.phase).toBe("complete");
		expect(second.checkedTables).toBe(3);
		expect(second.remainingTables).toBe(0);
		expect(second.failedTables).toBe(0);
	});

	it("stops at a checkpoint when cancelled before the next owner job", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const controller = new AbortController();
		controller.abort();

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.cancel",
			signal: controller.signal,
		});

		expect(result.phase).toBe("cancelled");
		expect(result.checkedTables).toBe(0);
		expect(result.cancellationReason).toContain("next table checkpoint");
	});

	it("uses the maintenance lane and records a bounded work estimate", async () => {
		const database = makeDatabase();
		await database.owner.start();
		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.lane",
			tablesPerRun: 1,
			maxWorkUnits: 1,
		});

		expect(result.checkedTables).toBe(1);
		expect(database.owner.health().activeJobId).toBeNull();
	});
});
