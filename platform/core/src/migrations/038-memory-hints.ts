import type { MigrationDb } from "./contract";

/**
 * Add prospective indexing: memory_hints table + FTS5 virtual table.
 *
 * At write time, the pipeline generates hypothetical future queries
 * ("hints") for each memory. These are indexed via FTS5 so that
 * search queries match memories by anticipated cue, not just by
 * stored content. Inspired by Kumiho (arXiv:2603.17244).
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_hints (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			hint TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(memory_id, hint)
		)
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_memory ON memory_hints(memory_id)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_agent ON memory_hints(agent_id)`);

	// FTS5 external-content table synced via triggers (same pattern as
	// memories_fts in 001 and entities_fts in 035).
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_hints_fts USING fts5(
			hint,
			content='memory_hints', content_rowid='rowid'
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ai AFTER INSERT ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ad AFTER DELETE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_au AFTER UPDATE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);
}
