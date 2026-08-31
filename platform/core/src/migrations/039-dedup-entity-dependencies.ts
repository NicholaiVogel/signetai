import type { MigrationDb } from "./contract";

/**
 * Add unique constraint on entity_dependencies to prevent duplicate rows.
 *
 * The inline entity linker and graph transactions both insert with
 * ON CONFLICT DO NOTHING, but no unique index existed — so duplicates
 * accumulated freely. This migration adds the missing constraint and
 * removes existing duplicates (keeping the oldest row per group).
 */
export function up(db: MigrationDb): void {
	// Remove duplicates first — keep the earliest row per
	// (source, target, type, agent_id) group.
	db.exec(`
		DELETE FROM entity_dependencies
		WHERE id NOT IN (
			SELECT MIN(id) FROM entity_dependencies
			GROUP BY source_entity_id, target_entity_id,
			         dependency_type, agent_id
		)
	`);

	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS
			idx_entity_deps_unique
		ON entity_dependencies(
			source_entity_id, target_entity_id,
			dependency_type, agent_id
		)
	`);
}
