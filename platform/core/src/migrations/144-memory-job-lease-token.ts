import type { MigrationDb } from "./contract";

/**
 * Add durable fencing tokens to memory_jobs leases.
 *
 * A worker may finish after shutdown or restart has recovered and re-leased the
 * same row. The token lets every worker-owned state transition prove that it
 * still owns the lease. Existing leases remain nullable so this is additive;
 * startup recovery clears any pre-migration leases before new work is issued.
 */
export function up(db: MigrationDb): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(memory_jobs)").all() as Array<{ name?: unknown }>)
			.map((row) => row.name)
			.filter((name): name is string => typeof name === "string"),
	);
	if (!columns.has("lease_token")) {
		db.exec("ALTER TABLE memory_jobs ADD COLUMN lease_token TEXT");
	}
}
