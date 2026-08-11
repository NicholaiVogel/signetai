import type { ReadDb } from "../db-accessor";
import { type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { renderDreamingEvidence } from "./dreaming-evidence";

/**
 * Durable per-source evidence delivery frontier (migration 129).
 *
 * One row exists per immutable evidence revision: (agent, kind, id,
 * captured_at, configured source entry id, content revision). The frontier is
 * `delivered_offset`, advanced only through contiguous delivery of rendered
 * fragments, and a revision is consumed iff `delivered_offset >= source_length`.
 *
 * This module exposes the truthful QUERY surface only: how much of a live
 * source revision has been delivered, and whether a configured source still
 * has eligible unconsumed evidence. Recording (advancing offsets from
 * persisted search_evidence output) is implemented separately on top of this
 * state. Every reader guards on table existence so pre-migration databases and
 * older builds keep working.
 */

function tableExists(db: ReadDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function sourceIdentity(source: EpisodicSourceRecord): string {
	return source.sourceEntryId ?? "";
}

function sourceRevision(source: EpisodicSourceRecord): string {
	return source.sourceRevision ?? source.capturedAt;
}

/** Delivered character offset for a live source revision, or 0 when nothing was delivered yet. */
export function deliveredOffsetForSource(db: ReadDb, agentId: string, source: EpisodicSourceRecord): number {
	if (!tableExists(db, "dreaming_evidence_consumption")) return 0;
	const row = db
		.prepare(
			`SELECT delivered_offset AS deliveredOffset FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
		)
		.get(agentId, source.kind, source.id, source.capturedAt, sourceIdentity(source), sourceRevision(source)) as {
		deliveredOffset: number;
	} | null;
	return Math.max(0, row?.deliveredOffset ?? 0);
}

/**
 * Narrow truthful completion query for one configured source.
 *
 * Returns true when any canonical, visible, non-empty artifact revision of the
 * configured source still has eligible undelivered rendered content, and false
 * only once every such revision is fully delivered. Never inferred from a
 * timestamp or an aggregate: each live artifact is re-read and its rendered
 * length compared against its own durable delivered offset.
 *
 * On a pre-migration database the table is absent and nothing has been
 * delivered yet, so the answer is truthfully true (unconsumed evidence may
 * exist). After full drain it is false.
 */
export function sourceHasEligibleUnconsumedEvidence(db: ReadDb, agentId: string, sourceEntryId: string): boolean {
	if (!tableExists(db, "dreaming_evidence_consumption")) return true;
	const rows = db
		.prepare(
			`SELECT ma.source_path FROM memory_artifacts ma
		 WHERE ma.agent_id = ? AND ma.source_id = ? AND COALESCE(ma.is_deleted, 0) = 0
		   AND length(ma.content) > 0
		   AND (ma.source_sha256 IS NULL OR ma.source_sha256 = ''
		        OR (ma.agent_id, ma.source_path) = (
		          SELECT ma2.agent_id, ma2.source_path FROM memory_artifacts ma2
		          WHERE ma2.agent_id = ma.agent_id AND COALESCE(ma2.is_deleted, 0) = 0
		            AND ma2.source_sha256 = ma.source_sha256
		            AND COALESCE(ma2.source_id, '') = COALESCE(ma.source_id, '')
		          ORDER BY ma2.captured_at DESC, ma2.source_path ASC
		          LIMIT 1
		        ))
		 ORDER BY ma.source_path ASC`,
		)
		.all(agentId, sourceEntryId) as Array<{ source_path: string }>;
	return rows.some((row) => {
		const source = readEpisodicSource(db, { agentId, from: `artifact:${row.source_path}` });
		return source !== null && deliveredOffsetForSource(db, agentId, source) < renderDreamingEvidence(source).length;
	});
}
