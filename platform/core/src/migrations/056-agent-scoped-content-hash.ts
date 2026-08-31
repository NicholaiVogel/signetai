import type { MigrationDb } from "./contract";

function ensureMemoriesScopeColumns(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memories)").all() as ReadonlyArray<Record<string, unknown>>;
	const names = new Set(cols.map((col) => col.name).filter((name): name is string => typeof name === "string"));
	if (!names.has("agent_id")) db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
	if (!names.has("scope")) db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
}

/**
 * Migration 056: Agent-aware content hash dedupe
 *
 * Summary facts and extracted memories may legitimately share identical
 * content across different agent scopes. Tighten the unique partial index so
 * duplicate content_hash values are only rejected within the same
 * (agent_id, scope) tuple.
 */
export function up(db: MigrationDb): void {
	// Defensive repair for stamped-but-partial databases.
	ensureMemoriesScopeColumns(db);

	db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
	db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(
			content_hash,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(scope, '__NULL__')
		)
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
