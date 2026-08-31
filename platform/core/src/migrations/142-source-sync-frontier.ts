/** Migration 142: add filesystem frontiers to the per-scan checkpoint table from migration 141. */
import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(source_sync_checkpoints)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "frontier")) {
		db.exec("ALTER TABLE source_sync_checkpoints ADD COLUMN frontier TEXT");
	}
}
