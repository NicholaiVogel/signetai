import type { MigrationDb } from "./index";

/**
 * Issue #901 — schema-light provenance table for `pruneTerminalJobs`.
 *
 * Before deleting terminal (`completed`, `dead`, `cancelled`) rows past
 * their retention window, the prune action copies them into
 * `job_archive`. The archive preserves the original row plus audit
 * metadata so operators retain provenance after cleanup.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_archive (
			id TEXT NOT NULL,
			source_table TEXT NOT NULL,
			payload TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_by TEXT,
			reason TEXT,
			PRIMARY KEY (source_table, id)
		)
	`);

	db.exec("CREATE INDEX IF NOT EXISTS idx_job_archive_source_table ON job_archive(source_table)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_job_archive_archived_at ON job_archive(archived_at)");
}
