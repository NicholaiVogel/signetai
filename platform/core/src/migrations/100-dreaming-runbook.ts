import type { MigrationDb } from "./contract";

/**
 * Per-pass operational memory for Dreaming. It records selected evidence and
 * the agent's structured runbook note without creating another semantic or
 * episodic store.
 */
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "evidence_window_json")) {
		db.exec("ALTER TABLE dreaming_passes ADD COLUMN evidence_window_json TEXT");
	}
	if (!columns.some((column) => column.name === "runbook_json")) {
		db.exec("ALTER TABLE dreaming_passes ADD COLUMN runbook_json TEXT");
	}
}
