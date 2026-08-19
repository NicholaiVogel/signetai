import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import { runIncrementalDatabaseIntegrityCheck } from "./incremental-database-integrity";
import { getDatabaseIntegrityStatus } from "./database-integrity";

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
		expect(first.checkedObjects).toBe(1);
		expect(first.remainingObjects).toBe(2);
		expect(first.lastObject).toBe("table:alpha");
		expect(first.databasePagesObserved).toBeGreaterThan(0);
		expect(first.databaseBytesObserved).toBeGreaterThan(0);
		expect(first.daemonMemoryRssBytes).toBeGreaterThan(0);

		const second = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.resume",
			tablesPerRun: 2,
			runBudgetMs: 5_000,
		});
		expect(second.phase).toBe("complete");
		expect(second.checkedObjects).toBe(3);
		expect(second.remainingObjects).toBe(0);
		expect(second.failedObjects).toBe(0);
		expect(getDatabaseIntegrityStatus()).toMatchObject({ state: "healthy", phase: "complete" });
		expect(getDatabaseIntegrityStatus().incrementalProgress?.phase).toBe("complete");
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
		expect(result.checkedObjects).toBe(0);
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

		expect(result.checkedObjects).toBe(1);
		expect(database.owner.health().activeJobId).toBeNull();
	});

	it("preserves the checkpoint across a hard 100ms run budget and resumes", async () => {
		const database = makeDatabase();
		const extraTables = new Database(database.path);
		for (let index = 0; index < 40; index += 1) extraTables.exec(`CREATE TABLE budget_${index} (value TEXT)`);
		extraTables.close();
		await database.owner.start();

		const timedOut = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.hard-budget",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 100,
			ownerDeadlineMs: 100,
		});
		expect(timedOut.phase).toBe("timed_out");
		expect(getDatabaseIntegrityStatus()).toMatchObject({ state: "unavailable", phase: "timed_out" });

		const resumed = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.hard-budget",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
		});
		expect(resumed.phase).toBe("complete");
		expect(resumed.checkedObjects).toBeGreaterThan(timedOut.checkedObjects);
	});

	it("enumerates indexes, views, triggers, and runs the targeted telemetry integrity phase", async () => {
		const database = makeDatabase();
		const db = new Database(database.path);
		db.exec(
			"CREATE TABLE telemetry_events (event TEXT); CREATE INDEX telemetry_event_idx ON telemetry_events(event); CREATE VIEW alpha_view AS SELECT value FROM alpha; CREATE TRIGGER alpha_trigger AFTER INSERT ON alpha BEGIN SELECT 1; END",
		);
		db.close();
		await database.owner.start();

		const result = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.schema-objects",
			tablesPerRun: 64,
			maxWorkUnits: 64,
			runBudgetMs: 5_000,
		});
		expect(result.phase).toBe("complete");
		expect(result.checkedObjects).toBeGreaterThanOrEqual(7);
	});

	it("resumes from a durable boundary after the owner dies before checkpoint commit", async () => {
		const database = makeDatabase();
		await database.owner.start();
		let interrupted = false;
		const first = await runIncrementalDatabaseIntegrityCheck({
			owner: database.owner,
			checkpointKey: "test.integrity.owner-interruption",
			tablesPerRun: 1,
			onBeforeCheckpointCommit: async () => {
				if (interrupted) return;
				interrupted = true;
				const pid = database.owner.health().pid;
				if (pid !== null) process.kill(pid, "SIGKILL");
				await database.owner.close();
				await new Promise((resolve) => setTimeout(resolve, 25));
			},
		});
		expect(first.phase).toBe("unavailable");
		expect(first.checkedObjects).toBe(0);

		const freshOwner = createDbOwnerClient({ dbPath: database.path });
		resources.push({ directory: database.directory, owner: freshOwner });
		await freshOwner.start();
		const resumed = await runIncrementalDatabaseIntegrityCheck({
			owner: freshOwner,
			checkpointKey: "test.integrity.owner-interruption",
			tablesPerRun: 3,
		});
		expect(resumed.phase).toBe("complete");
		expect(resumed.checkedObjects).toBe(3);
	});
});
