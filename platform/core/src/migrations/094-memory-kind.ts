import { DAEMON_DERIVED_MEMORY_SOURCE_TYPES } from "../memory-provenance";
/**
 * Migration 094: Add `memories.memory_kind` and `memories.evidence_meta`, and
 * backfill episodic evidence.
 *
 * remember/CLI/MCP/plugin/harness saves are immutable EPISODIC evidence: the
 * saved memory is immediately retrievable but is not a direct semantic-graph
 * write. Only Dreaming derives semantic state from episodic rows.
 *
 * This migration adds two nullable columns to `memories`:
 *
 *   - `memory_kind TEXT` — classifies the row as `'episodic'` (primary
 *     evidence) or NULL (daemon-derived). Backfills existing rows.
 *   - `evidence_meta TEXT` — optional canonical JSON blob preserving
 *     structured remember payloads (entities/aspects) verbatim alongside the
 *     content. This lets Dreaming reason over structured evidence without any
 *     direct graph write at save time.
 *
 * Classification uses an EXCLUSION list of daemon-derived source_types rather
 * than a whitelist, so real in-session user/tool/plugin input (which may carry
 * arbitrary client-provided `sourceType` values such as `manual`, `chunk`,
 * `codex_native_memory`, `hermes-memory`, `openclaw-memory-log`,
 * `reflection-answer`, or any custom harness/tool value) is classified episodic
 * without needing to enumerate every client. The excluded source_types are the
 * daemon's own derived outputs:
 *
 *   - `extract`           — legacy extraction pipeline output
 *   - `aggregate-recall`  — daemon-synthesized aggregate recall answer
 *   - `session_end`       — summary-worker session-end derived facts
 *   - `checkpoint`        — summary-worker checkpoint derived facts
 *
 * Rows that are already deleted (tombstoned) are backfilled too so the kind
 * label survives recovery. Rows with a NULL source_type (pre-migration-013
 * schemas) are treated as agent-authored evidence and backfilled episodic,
 * since the extraction pipeline always stamps a non-null source_type.
 *
 * Idempotent: re-runs are no-ops because the UPDATE is conditional on
 * `memory_kind IS NULL`.
 */
import type { MigrationDb } from "./contract";

/** Daemon-derived source_types that are NOT primary episodic evidence. */
const DERIVED_SOURCE_TYPES = DAEMON_DERIVED_MEMORY_SOURCE_TYPES;

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((r) => r.name === column);
}

export function up(db: MigrationDb): void {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memories'")
		.all() as ReadonlyArray<Record<string, unknown>>;
	if (tables.length === 0) return;

	if (!hasColumn(db, "memories", "memory_kind")) {
		db.exec("ALTER TABLE memories ADD COLUMN memory_kind TEXT");
	}
	if (!hasColumn(db, "memories", "evidence_meta")) {
		db.exec("ALTER TABLE memories ADD COLUMN evidence_meta TEXT");
	}

	// Backfill all non-derived rows as episodic evidence. We exclude the known
	// daemon-derived source_types; everything else (including NULL source_type
	// from pre-migration-013 schemas) is agent-authored primary evidence.
	// Guard against schemas that predate the source_type column (migration 013).
	if (hasColumn(db, "memories", "source_type")) {
		const placeholders = DERIVED_SOURCE_TYPES.map(() => "?").join(", ");
		db.prepare(
			`UPDATE memories
				 SET memory_kind = 'episodic'
				 WHERE memory_kind IS NULL
				   AND (source_type IS NULL OR source_type NOT IN (${placeholders}))`,
		).run(...DERIVED_SOURCE_TYPES);
	} else {
		// No source_type column — all rows are pre-pipeline evidence.
		db.exec(
			`UPDATE memories
			 SET memory_kind = 'episodic'
			 WHERE memory_kind IS NULL`,
		);
	}
}
