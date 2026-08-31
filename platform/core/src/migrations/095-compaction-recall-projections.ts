/**
 * Migration 095: compaction rows in `memories` are retrieval projections,
 * not primary episodic evidence. Their temporal-DAG summary is Dreaming's
 * canonical input, while the memory row remains available to ordinary recall.
 */
import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}

export function up(db: MigrationDb): void {
	const hasMemories = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
	if (!hasMemories || !hasColumn(db, "memories", "memory_kind") || !hasColumn(db, "memories", "type")) return;
	db.exec("UPDATE memories SET memory_kind = NULL WHERE type = 'session_summary'");
}
