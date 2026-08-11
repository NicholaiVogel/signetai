import type { MigrationDb } from "./index";

function tableExists(db: MigrationDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

/**
 * Migration 129: retire the structural queues removed by the Dreaming cutover
 * (#1391).
 *
 * `structural_classify` and `structural_dependency` no longer have workers or
 * producers. Pending and leased rows cannot make progress, but they still make
 * queue health look unhealthy and indefinitely defer automatic Dreaming. Keep
 * the source rows for operator provenance: copy each original row into the
 * existing cancellation audit before marking it cancelled. Terminal rows and
 * every other job type are intentionally untouched.
 *
 * The migration runner wraps this complete audit-and-cancel operation in one
 * savepoint, so an audit write failure rolls back the status change too.
 */
export function up(db: MigrationDb): void {
	if (!tableExists(db, "memory_jobs")) return;
	if (!tableExists(db, "job_cancellations")) {
		throw new Error("job_cancellations table missing; cannot retire structural jobs without an audit trail");
	}

	// Execute the audit through a prepared statement. bun:sqlite's multi-statement
	// exec can continue after an INSERT trigger aborts; this throws before the
	// cancellation statement and lets the runner's savepoint restore all state.
	db.prepare(`
		INSERT INTO job_cancellations (
			id, source_table, source_id, status_before, payload_json,
			reason, actor, actor_type, request_id, created_at
		)
		SELECT
			'retire-structural-jobs-129:' || id,
			'memory_jobs',
			id,
			status,
			json_object(
				'id', id,
				'memory_id', memory_id,
				'document_id', document_id,
				'job_type', job_type,
				'status', status,
				'payload', payload,
				'result', result,
				'attempts', attempts,
				'max_attempts', max_attempts,
				'leased_at', leased_at,
				'completed_at', completed_at,
				'failed_at', failed_at,
				'error', error,
				'created_at', created_at,
				'updated_at', updated_at
			),
			'retired structural queue after Dreaming cutover',
			'migration:129',
			'system',
			NULL,
			strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		FROM memory_jobs
		WHERE job_type IN ('structural_classify', 'structural_dependency')
		  AND status IN ('pending', 'leased');
	`).run();

	db.exec(`
		UPDATE memory_jobs
		SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE job_type IN ('structural_classify', 'structural_dependency')
		  AND status IN ('pending', 'leased');
	`);
}
