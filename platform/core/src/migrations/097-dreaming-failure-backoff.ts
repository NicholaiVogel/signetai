import type { MigrationDb } from "./contract";

/** Persist the timestamp used for Dreaming's restart-safe retry backoff. */
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_state)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "last_failure_at")) {
		db.exec("ALTER TABLE dreaming_state ADD COLUMN last_failure_at TEXT");
	}
	// Existing failure counts predate a failure timestamp. Treat their last
	// state update as the conservative retry anchor rather than retrying every
	// tick or requiring an unreachable amount of new evidence.
	db.exec(
		"UPDATE dreaming_state SET last_failure_at = updated_at WHERE consecutive_failures > 0 AND last_failure_at IS NULL",
	);
}
