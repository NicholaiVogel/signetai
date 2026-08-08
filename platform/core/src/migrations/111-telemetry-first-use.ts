/**
 * Migration 111: Telemetry first-use milestones
 *
 * Extends the telemetry_install row (migration 109) with one-shot
 * first-use timestamps. The daemon claims a milestone with an atomic
 * guarded UPDATE (only the first caller wins, changes === 1) and emits
 * first.remember / first.recall exactly once per install, so the
 * activation funnel (install.activated -> first.remember/recall) counts
 * installs that were actually used, not just booted.
 *
 * Idempotent: guards each ADD COLUMN with a pragma check (SQLite ALTER
 * has no IF NOT EXISTS).
 */
import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

const COLUMNS = ["first_remember_at", "first_recall_at"] as const;

export function up(db: MigrationDb): void {
	for (const column of COLUMNS) {
		if (!hasColumn(db, "telemetry_install", column)) {
			db.exec(`ALTER TABLE telemetry_install ADD COLUMN ${column} TEXT`);
		}
	}
}
