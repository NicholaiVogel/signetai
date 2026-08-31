import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}

const TOKEN_COLUMNS: ReadonlyArray<[string, string]> = [
	["tokens_input", "INTEGER"],
	["tokens_output", "INTEGER"],
	["tokens_cache_read", "INTEGER"],
	["tokens_cache_write", "INTEGER"],
	["tokens_cost", "REAL"],
];

/**
 * Migration 107: provider-reported token usage breakdown on dreaming_passes.
 *
 * Previously `tokens_consumed` held only a local BPE estimate of the prompt
 * text. Pi-backed agent sessions report real per-call usage
 * (`AgentSession.getSessionStats()`: input/output/cacheRead/cacheWrite
 * tokens plus cost), so a pass record can carry the full provider-reported
 * breakdown instead of an input-only estimate. `tokens_consumed` continues
 * to hold the total for backward-compatible readers; the new columns are
 * additive and nullable — rows written before this migration stay intact,
 * and ACPX-backed passes (which report no usage) leave them NULL.
 */
export function up(db: MigrationDb): void {
	for (const [column, type] of TOKEN_COLUMNS) {
		if (!hasColumn(db, "dreaming_passes", column)) {
			db.exec(`ALTER TABLE dreaming_passes ADD COLUMN ${column} ${type};`);
		}
	}
}
