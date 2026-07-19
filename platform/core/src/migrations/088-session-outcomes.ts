import type { MigrationDb } from "./index";

/**
 * Issue #902 — session lifecycle outcome audit table.
 *
 * TTL expiry of a tracked session is a formal lifecycle transition: every
 * transition writes one audit row here recording whether finalization ran
 * (checkpoint + summary enqueue) or was intentionally skipped (with the
 * skip reason). Modeled on the job_cancellations audit pattern.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_outcomes (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			session_id TEXT,
			agent_id TEXT,
			outcome TEXT NOT NULL,
			reason TEXT NOT NULL,
			skip_reason TEXT,
			checkpoint_id TEXT,
			summary_job_id TEXT,
			payload_json TEXT,
			actor TEXT NOT NULL DEFAULT 'daemon',
			actor_type TEXT NOT NULL DEFAULT 'daemon',
			request_id TEXT,
			created_at TEXT NOT NULL
		)
	`);

	const indexes = db.prepare(`PRAGMA index_list('session_outcomes')`).all() as ReadonlyArray<Record<string, unknown>>;
	const names = new Set(indexes.map((r) => String(r.name ?? "")));

	if (!names.has("idx_session_outcomes_key_reason")) {
		db.exec(`
			CREATE INDEX idx_session_outcomes_key_reason
			ON session_outcomes(session_key, reason)
		`);
	}
	if (!names.has("idx_session_outcomes_outcome_created")) {
		db.exec(`
			CREATE INDEX idx_session_outcomes_outcome_created
			ON session_outcomes(outcome, created_at)
		`);
	}
}
