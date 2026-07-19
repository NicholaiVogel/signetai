import type { MigrationDb } from "./index";

/**
 * Issue #901 — schema-light provenance table for `cancelObsoleteJobs`.
 *
 * Rather than add a `cancelled` status to `summary_jobs` / `memory_jobs`,
 * the cancel action deletes the row from its source table and copies a
 * full snapshot of it into `job_cancellations`. This keeps existing job
 * enqueue/lease/dequeue paths untouched while preserving the audit trail
 * required by the issue's regression test.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_cancellations (
			id TEXT PRIMARY KEY,
			source_table TEXT NOT NULL,
			payload TEXT NOT NULL,
			reason TEXT,
			cancelled_at TEXT NOT NULL,
			cancelled_by TEXT,
			actor_type TEXT,
			request_id TEXT
		)
	`);

	db.exec("CREATE INDEX IF NOT EXISTS idx_job_cancellations_source_table ON job_cancellations(source_table)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_job_cancellations_cancelled_at ON job_cancellations(cancelled_at)");
}
