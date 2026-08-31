import type { MigrationDb } from "./contract";

/**
 * Migration 030: Make memory_jobs.memory_id nullable
 *
 * The memory_jobs table was created in 002 with `memory_id TEXT NOT NULL`.
 * Migration 007 added document_id for document_ingest jobs, but those jobs
 * don't have a memory_id at creation time — they produce memories later.
 * The NOT NULL constraint causes POST /api/documents to fail with:
 *   SQLiteError: NOT NULL constraint failed: memory_jobs.memory_id
 *
 * SQLite doesn't support ALTER COLUMN, so we rebuild the table.
 *
 * No artifacts declared: this migration modifies an existing table's
 * constraint (not a new table/column). The memory_jobs table is already
 * tracked by migration 002's artifacts, so phantom detection still works.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs_new (
			id TEXT PRIMARY KEY,
			memory_id TEXT,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			document_id TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		)
	`);

	db.exec(`
		INSERT INTO memory_jobs_new
			(id, memory_id, job_type, status, payload, result,
			 attempts, max_attempts, leased_at, completed_at, failed_at,
			 error, created_at, updated_at, document_id)
		SELECT
			id, memory_id, job_type, status, payload, result,
			attempts, max_attempts, leased_at, completed_at, failed_at,
			error, created_at, updated_at, document_id
		FROM memory_jobs
	`);

	db.exec("DROP TABLE IF EXISTS memory_jobs");
	db.exec("ALTER TABLE memory_jobs_new RENAME TO memory_jobs");

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at);
	`);
}
