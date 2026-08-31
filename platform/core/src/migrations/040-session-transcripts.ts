import type { MigrationDb } from "./contract";

/**
 * Migration 040: Session Transcripts (Lossless Retention)
 *
 * Stores raw session transcripts alongside extracted facts.
 * Extraction creates the search surface; the transcript preserves
 * completeness so nothing is permanently lost.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcripts (
			session_key TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
	`);
}
