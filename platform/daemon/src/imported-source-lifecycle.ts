import { createHash } from "node:crypto";
import { SOURCE_CHUNK_SOURCE_TYPE } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countChanges, syncVecDeleteByEmbeddingIds } from "./db-helpers";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";

export interface MarkImportedSourceUnsupportedInput {
	readonly sourceId: string;
	readonly agentId: string;
	readonly reason?: string;
}

export interface MarkImportedSourceUnsupportedResult {
	readonly artifacts: number;
	readonly embeddings: number;
}

/**
 * Detach imported evidence without deleting ontology derived from it. The
 * lifecycle row is the durable marker used by Dreaming/hygiene review; graph
 * rows keep their original source_id/source_path provenance.
 */
export function markImportedSourceUnsupported(
	input: MarkImportedSourceUnsupportedInput,
): MarkImportedSourceUnsupportedResult {
	const sourceId = input.sourceId.trim();
	const agentId = input.agentId.trim();
	if (!sourceId || !agentId) return { artifacts: 0, embeddings: 0 };
	return getDbAccessor().withWriteTx((db) => {
		const now = new Date().toISOString();
		const reason = input.reason?.trim() || "imported source removed";
		db.prepare(
			`INSERT INTO imported_source_lifecycle
			 (id, source_id, agent_id, status, reason, removed_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'unsupported', ?, ?, ?, ?)
			 ON CONFLICT(source_id, agent_id) DO UPDATE SET
			   status = 'unsupported', reason = excluded.reason,
			   removed_at = excluded.removed_at, updated_at = excluded.updated_at,
			   reviewed_at = NULL`,
		).run(
			`import-lifecycle:${createHash("sha256").update(`${agentId}\0${sourceId}`).digest("hex")}`,
			sourceId,
			agentId,
			reason,
			now,
			now,
			now,
		);

		const artifacts = countChanges(
			db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_id = ?").run(agentId, sourceId),
		);
		const prefix = `${sourceId}:`;
		const embeddingRows = db
			.prepare(
				`SELECT id FROM embeddings
				 WHERE agent_id = ? AND source_type = ? AND source_id >= ? AND source_id < ?`,
			)
			.all(agentId, SOURCE_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`) as Array<{ id: string }>;
		const embeddingIds = embeddingRows.map((row) => row.id);
		syncVecDeleteByEmbeddingIds(db, embeddingIds);
		if (embeddingIds.length > 0) {
			const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
			for (const id of embeddingIds) stmt.run(id);
		}

		enqueueDreamingAttentionInTx(db, {
			agentId,
			kind: "hygiene",
			subjectRef: `source:${sourceId}`,
			details: { sourceId, reason: "import-source-removed", lifecycle: "unsupported" },
			priority: 90,
		});
		return { artifacts, embeddings: embeddingIds.length };
	});
}
