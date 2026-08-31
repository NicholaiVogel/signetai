import type { MigrationDb } from "./contract";

/**
 * Make the content_hash unique index scope-aware.
 *
 * The original idx_memories_content_hash_unique prevents duplicate content
 * regardless of scope. With scoped memories (benchmarks, namespaced data),
 * the same content legitimately exists in multiple scopes. Replace the
 * global unique index with one that uses COALESCE(scope, '__NULL__') so
 * duplicates are only blocked within the same scope.
 */
export function up(db: MigrationDb): void {
	db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
	db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(content_hash, COALESCE(scope, '__NULL__'))
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
