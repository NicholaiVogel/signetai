import { afterEach, describe, expect, it } from "bun:test";
import { repairTelemetryIndexes } from "./database-integrity";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";

function fakeAccessor(options: { readonly quickMessage?: string; readonly telemetryMessage?: string }): {
	readonly accessor: DbAccessor;
	readonly reindexed: string[];
} {
	let repaired = false;
	const reindexed: string[] = [];
	const accessor: DbAccessor = {
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn({
				prepare(sql: string) {
					return {
						run(): { readonly changes: number } {
							return { changes: 0 };
						},
						get(): undefined {
							return undefined;
						},
						all(): unknown[] {
							if (sql === "PRAGMA quick_check") {
								return [{ quick_check: options.quickMessage ?? "ok" }];
							}
							if (sql === "PRAGMA integrity_check(telemetry_events)") {
								return [{ integrity_check: repaired ? "ok" : (options.telemetryMessage ?? "ok") }];
							}
							throw new Error(`unexpected query: ${sql}`);
						},
					};
				},
			} as ReadDb);
		},
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			return fn({
				exec(sql: string): void {
					repaired = true;
					reindexed.push(sql);
				},
				prepare() {
					return {
						run(): { readonly changes: number } {
							return { changes: 0 };
						},
						get(): undefined {
							return undefined;
						},
						all(): unknown[] {
							return [];
						},
					};
				},
			} as WriteDb);
		},
		close(): void {},
	};
	return { accessor, reindexed };
}

afterEach(() => {
	repairTelemetryIndexes(fakeAccessor({}).accessor);
});

describe("telemetry database integrity recovery (#1360)", () => {
	it("rebuilds disposable telemetry indexes after quick_check misses the mismatch", () => {
		const { accessor, reindexed } = fakeAccessor({
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = repairTelemetryIndexes(accessor);

		expect(result.state).toBe("repaired");
		expect(result.quickCheck.ok).toBe(true);
		expect(result.telemetryCheck.ok).toBe(true);
		expect(reindexed).toEqual([
			'REINDEX "idx_telemetry_events_event"',
			'REINDEX "idx_telemetry_events_timestamp"',
			'REINDEX "idx_telemetry_events_unsent"',
		]);
	});

	it("audits the repair inside the write transaction", () => {
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });
		let auditedIndexes: readonly string[] = [];
		let detectionMessages: readonly string[] = [];

		const result = repairTelemetryIndexes(accessor, (_db, indexes, messages) => {
			auditedIndexes = indexes;
			detectionMessages = messages;
		});

		expect(result.state).toBe("repaired");
		expect(auditedIndexes).toEqual([
			"idx_telemetry_events_event",
			"idx_telemetry_events_timestamp",
			"idx_telemetry_events_unsent",
		]);
		expect(detectionMessages).toEqual(["index mismatch"]);
	});

	it("does not rewrite an unrelated database when quick_check fails", () => {
		const { accessor, reindexed } = fakeAccessor({
			quickMessage: "database disk image is malformed",
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = repairTelemetryIndexes(accessor);

		expect(result.state).toBe("corrupt");
		expect(result.quickCheck.ok).toBe(false);
		expect(reindexed).toEqual([]);
	});
});
