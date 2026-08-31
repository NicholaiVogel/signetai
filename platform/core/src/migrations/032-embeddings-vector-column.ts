import type { MigrationDb } from "./contract";

/**
 * Migration 032: Ensure embeddings.vector column exists
 *
 * Databases created on older Signet versions may lack the `vector BLOB`
 * column on `embeddings`. Without it, `reembedMissingMemories` throws
 * "table embeddings has no column named vector" and the daemon returns
 * an unhandled 500 to the CLI.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table doesn't exist yet — baseline will create it with vector
	if (!cols.some((c) => c.name === "vector")) {
		db.exec("ALTER TABLE embeddings ADD COLUMN vector BLOB");
	}
}
