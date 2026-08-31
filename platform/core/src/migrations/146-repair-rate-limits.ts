import type { MigrationDb } from "./contract";

/**
 * Durable admission history for repair actions. The daemon keeps no production
 * limiter truth in process memory; this table survives restart and is updated
 * through the database transaction boundary.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS repair_rate_limits (
			action TEXT NOT NULL,
			scope_key TEXT NOT NULL,
			last_run_at TEXT,
			window_started_at TEXT NOT NULL,
			hourly_count INTEGER NOT NULL DEFAULT 0 CHECK (hourly_count >= 0),
			updated_at TEXT NOT NULL,
			PRIMARY KEY (action, scope_key)
		);
		CREATE INDEX IF NOT EXISTS idx_repair_rate_limits_updated
			ON repair_rate_limits(updated_at);
	`);
}
