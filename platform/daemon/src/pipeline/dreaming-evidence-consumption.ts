import type { ReadDb, WriteDb } from "../db-accessor";
import { type EpisodicSourceKind, type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { renderDreamingEvidence } from "./dreaming-evidence";

export interface DreamingEvidenceDelivery {
	readonly agentId: string;
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly capturedAt: string;
	readonly sourceRevision: string;
	readonly start: number;
	readonly end: number;
	readonly length: number;
	readonly content: string;
}

function tableExists(db: ReadDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function sourceIdentity(source: EpisodicSourceRecord): string {
	return source.sourceEntryId ?? "";
}

function sourceRevision(source: EpisodicSourceRecord): string {
	return source.sourceRevision ?? source.capturedAt;
}

function sourceRef(value: string): { readonly kind: EpisodicSourceKind; readonly id: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0) return null;
	const kind = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if (!id || !["memory", "artifact", "transcript", "summary"].includes(kind)) return null;
	return { kind: kind as EpisodicSourceKind, id };
}

/** Parse exact fragments persisted in Dreaming tool-call output. Invalid rows never acknowledge evidence. */
export function persistedEvidenceDeliveries(db: ReadDb, passId: string): readonly DreamingEvidenceDelivery[] {
	if (!tableExists(db, "dreaming_tool_calls")) return [];
	const rows = db
		.prepare(
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls
			 WHERE pass_id = ? AND tool_name = 'search_evidence' ORDER BY sequence ASC`,
		)
		.all(passId) as Array<{ inputJson: string; outputJson: string }>;
	return rows.flatMap(({ inputJson, outputJson }) => {
		let input: unknown;
		let output: unknown;
		try {
			input = JSON.parse(inputJson);
			output = JSON.parse(outputJson);
		} catch {
			return [];
		}
		const agentId = text(record(input)?.agentId);
		const data = record(output);
		if (!agentId || data?.ok !== true || !Array.isArray(data.items)) return [];
		return data.items.flatMap((item) => {
			const row = record(item);
			const ref = text(row?.sourceRef);
			const parsed = ref ? sourceRef(ref) : null;
			const capturedAt = text(row?.capturedAt);
			const sourceRevision = text(row?.sourceRevision);
			const start =
				typeof row?.contentOffset === "number" && Number.isSafeInteger(row.contentOffset) ? row.contentOffset : null;
			const content = text(row?.content);
			const length =
				typeof row?.contentLength === "number" && Number.isSafeInteger(row.contentLength) ? row.contentLength : null;
			if (
				!parsed ||
				!capturedAt ||
				!sourceRevision ||
				start === null ||
				!content ||
				length === null ||
				start < 0 ||
				length < start
			)
				return [];
			const end = start + content.length;
			if (end > length) return [];
			return [{ agentId, kind: parsed.kind, id: parsed.id, capturedAt, sourceRevision, start, end, length, content }];
		});
	});
}

function verifiedDelivery(db: ReadDb, delivery: DreamingEvidenceDelivery): EpisodicSourceRecord | null {
	const source = readEpisodicSource(db, { agentId: delivery.agentId, from: `${delivery.kind}:${delivery.id}` });
	if (
		source === null ||
		source.capturedAt !== delivery.capturedAt ||
		sourceRevision(source) !== delivery.sourceRevision
	)
		return null;
	const rendered = renderDreamingEvidence(source);
	if (
		rendered.length !== delivery.length ||
		delivery.end > rendered.length ||
		rendered.slice(delivery.start, delivery.end) !== delivery.content
	) {
		return null;
	}
	return source;
}

/** Advance only contiguous delivery. A fragment after a gap is durable audit evidence but never a completion acknowledgement. */
export function recordDreamingEvidenceConsumptionInTx(
	db: WriteDb,
	params: { readonly passId: string; readonly deferredEvidence: ReadonlySet<string> },
): void {
	if (!tableExists(db, "dreaming_evidence_consumption")) return;
	const deliveries = persistedEvidenceDeliveries(db, params.passId)
		.filter((delivery) => !params.deferredEvidence.has(`${delivery.agentId}\u0000${delivery.kind}:${delivery.id}`))
		.sort(
			(a, b) =>
				a.agentId.localeCompare(b.agentId) ||
				a.kind.localeCompare(b.kind) ||
				a.id.localeCompare(b.id) ||
				a.capturedAt.localeCompare(b.capturedAt) ||
				a.start - b.start ||
				a.end - b.end,
		);
	const select = db.prepare(
		`SELECT delivered_offset AS deliveredOffset FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
	);
	const upsert = db.prepare(
		`INSERT INTO dreaming_evidence_consumption
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision) DO UPDATE SET
		   delivered_offset = excluded.delivered_offset,
		   source_length = excluded.source_length,
		   pass_id = excluded.pass_id,
		   updated_at = excluded.updated_at`,
	);
	for (const delivery of deliveries) {
		const source = verifiedDelivery(db, delivery);
		if (source === null) continue;
		const identity = sourceIdentity(source);
		const revision = sourceRevision(source);
		const row = select.get(delivery.agentId, delivery.kind, delivery.id, delivery.capturedAt, identity, revision) as {
			deliveredOffset: number;
		} | null;
		const current = row?.deliveredOffset ?? 0;
		if (delivery.start > current) continue;
		const next = Math.max(current, delivery.end);
		if (next <= current && row != null) continue;
		upsert.run(
			delivery.agentId,
			delivery.kind,
			delivery.id,
			delivery.capturedAt,
			identity,
			revision,
			Math.min(next, delivery.length),
			delivery.length,
			params.passId,
		);
	}
}

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

/** Narrow truthful completion query for one configured source. */
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
