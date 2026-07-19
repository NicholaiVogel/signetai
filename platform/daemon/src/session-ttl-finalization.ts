/**
 * Session TTL finalization (issue #902)
 *
 * TTL expiry of a tracked session is a formal, auditable lifecycle
 * transition. Before the tracker evicts a stale claim, this module:
 *
 * 1. persists a final transcript checkpoint (`trigger: "ttl_expired"`),
 * 2. enqueues an idempotent summary job (`boundary_reason: "ttl_expired"`,
 *    content-derived session id) when pipeline policy allows, and
 * 3. writes a `session_outcomes` audit row recording the transition —
 *    including the explicit skip reason when finalization is
 *    intentionally not performed (synthesis disabled, transcript too
 *    short, noise session, duplicate job, or no stored transcript).
 *
 * Re-finalization for the same session key is a no-op: the audit row is
 * the idempotency guard.
 */

import { randomUUID } from "node:crypto";
import { resolveDefaultBasePath } from "@signet/core";
import { type DbAccessor, type ReadDb, type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { loadMemoryConfig } from "./memory-config";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import { writeCheckpoint } from "./session-checkpoints";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { isNoiseSession } from "./session-noise";
import { type SessionExpiredInfo, setSessionExpirationHandler } from "./session-tracker";
import { getSessionTranscriptContent, getStoredSessionTranscriptInfo } from "./session-transcripts";

export type SessionOutcomeSkipReason =
	| "pipeline-disabled"
	| "transcript-too-short"
	| "noise-session"
	| "duplicate-job"
	| "no-transcript";

export interface SessionOutcomeRecord {
	readonly outcome: "finalized" | "skipped" | "already-recorded";
	readonly skipReason?: SessionOutcomeSkipReason;
	readonly checkpointId?: string;
	readonly summaryJobId?: string;
}

const MIN_TRANSCRIPT_CHARS = 500;
const TTL_REASON = "ttl_expired";

function tableExists(db: ReadDb | WriteDb, table: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	return row != null;
}

function existingOutcome(db: ReadDb | WriteDb, sessionKey: string, agentId: string): { id: string } | undefined {
	if (!tableExists(db, "session_outcomes")) return undefined;
	return db
		.prepare(
			`SELECT id FROM session_outcomes
			 WHERE session_key = ? AND agent_id = ? AND reason = ?
			 LIMIT 1`,
		)
		.get(sessionKey, agentId, TTL_REASON) as { id: string } | undefined;
}

function summaryJobExists(db: ReadDb | WriteDb, sessionKey: string, sessionId: string, agentId: string): boolean {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(summary_jobs)").all() as Array<{ name?: unknown }>)
			.map((r) => (typeof r.name === "string" ? r.name : ""))
			.filter((n) => n.length > 0),
	);
	if (columns.has("session_id")) {
		const agentClause = columns.has("agent_id") ? " AND agent_id = ?" : "";
		const args = columns.has("agent_id") ? [sessionId, agentId] : [sessionId];
		return (
			db
				.prepare(`SELECT id FROM summary_jobs WHERE session_id = ?${agentClause} AND status <> 'dead' LIMIT 1`)
				.get(...args) != null
		);
	}
	return (
		db.prepare("SELECT id FROM summary_jobs WHERE session_key = ? AND status <> 'dead' LIMIT 1").get(sessionKey) != null
	);
}

function writeOutcomeRow(
	accessor: DbAccessor,
	info: SessionExpiredInfo,
	record: Exclude<SessionOutcomeRecord, { readonly outcome: "already-recorded" }>,
	sessionId: string | undefined,
): void {
	accessor.withWriteTx((db) => {
		if (!tableExists(db, "session_outcomes")) return;
		// Idempotency guard: a concurrent or repeated transition for the same
		// session key must not produce a second audit row.
		if (existingOutcome(db, info.key, info.agentId)) return;
		db.prepare(
			`INSERT INTO session_outcomes
			 (id, session_key, session_id, agent_id, outcome, reason, skip_reason,
			  checkpoint_id, summary_job_id, payload_json, actor, actor_type, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'daemon', 'daemon', NULL, ?)`,
		).run(
			randomUUID(),
			info.key,
			sessionId ?? null,
			info.agentId,
			record.outcome,
			TTL_REASON,
			record.skipReason ?? null,
			record.checkpointId ?? null,
			record.summaryJobId ?? null,
			JSON.stringify({
				runtimePath: info.runtimePath,
				claimedAt: info.claimedAt,
			}),
			new Date().toISOString(),
		);
	});
}

/**
 * Run the auditable TTL-expiry transition for one evicted session claim.
 * Never throws — failures are logged so tracker eviction is never blocked.
 */
export function finalizeExpiredSession(info: SessionExpiredInfo): SessionOutcomeRecord {
	try {
		return finalizeExpiredSessionInner(info);
	} catch (error) {
		logger.warn("session-ttl", "TTL finalization failed", {
			sessionKey: info.key,
			error: error instanceof Error ? error.message : String(error),
		});
		return { outcome: "skipped", skipReason: "no-transcript" };
	}
}

function finalizeExpiredSessionInner(info: SessionExpiredInfo): SessionOutcomeRecord {
	const accessor = getDbAccessor();

	// Idempotency: this transition may already be recorded (overlapping
	// sweep + opportunistic eviction, or a daemon restart mid-sweep).
	const prior = accessor.withReadDb((db) => existingOutcome(db, info.key, info.agentId));
	if (prior) return { outcome: "already-recorded" };

	const transcript = getSessionTranscriptContent(info.key, info.agentId)?.trim() ?? "";
	const stored = getStoredSessionTranscriptInfo(info.key, info.agentId);
	const harness = stored?.harness ?? "unknown";
	const project = stored?.project ?? undefined;
	const sessionId = transcript.length > 0 ? deriveSessionEndFallbackId(info.key, undefined, transcript) : undefined;

	if (transcript.length === 0) {
		const record: SessionOutcomeRecord = { outcome: "skipped", skipReason: "no-transcript" };
		writeOutcomeRow(accessor, info, record, undefined);
		logger.info("session-ttl", "TTL finalization skipped", { sessionKey: info.key, reason: "no-transcript" });
		return record;
	}

	// Persist the latest checkpoint before any further transition so the
	// session is recoverable even if later steps fail.
	const memoryCfg = loadMemoryConfig(resolveDefaultBasePath());
	writeCheckpoint(
		accessor,
		{
			sessionKey: info.key,
			harness,
			project,
			projectNormalized: project,
			trigger: "ttl_expired",
			digest: `Session expired via TTL without a session-end event; lifecycle transition recorded (${info.runtimePath} path).`,
			promptCount: 0,
			memoryQueries: [],
			recentRemembers: [],
		},
		memoryCfg.pipelineV2.continuity.maxCheckpointsPerSession,
	);
	const checkpointId = accessor.withReadDb(
		(db) =>
			(
				db
					.prepare(
						`SELECT id FROM session_checkpoints
						 WHERE session_key = ? AND trigger = 'ttl_expired'
						 ORDER BY created_at DESC LIMIT 1`,
					)
					.get(info.key) as { id: string } | undefined
			)?.id,
	);

	const pipelineEnabled = memoryCfg.pipelineV2.enabled || memoryCfg.pipelineV2.shadowMode || memoryCfg.dreaming.enabled;
	const skipReason: SessionOutcomeSkipReason | null = !pipelineEnabled
		? "pipeline-disabled"
		: transcript.length < MIN_TRANSCRIPT_CHARS
			? "transcript-too-short"
			: isNoiseSession({ project, sessionKey: info.key, sessionId, harness })
				? "noise-session"
				: null;

	if (skipReason) {
		const record: SessionOutcomeRecord = { outcome: "skipped", skipReason, checkpointId };
		writeOutcomeRow(accessor, info, record, sessionId);
		logger.info("session-ttl", "TTL finalization skipped", {
			sessionKey: info.key,
			reason: skipReason,
			transcriptChars: transcript.length,
		});
		return record;
	}

	const duplicate = accessor.withReadDb((db) => summaryJobExists(db, info.key, sessionId ?? info.key, info.agentId));
	if (duplicate) {
		const record: SessionOutcomeRecord = { outcome: "skipped", skipReason: "duplicate-job", checkpointId };
		writeOutcomeRow(accessor, info, record, sessionId);
		logger.info("session-ttl", "TTL finalization skipped", { sessionKey: info.key, reason: "duplicate-job" });
		return record;
	}

	const summaryJobId = enqueueSummaryJob(accessor, {
		harness,
		transcript,
		sessionKey: info.key,
		sessionId,
		project,
		agentId: info.agentId,
		trigger: "ttl_expired",
		boundaryReason: TTL_REASON,
		capturedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	});

	const record: SessionOutcomeRecord = { outcome: "finalized", checkpointId, summaryJobId };
	writeOutcomeRow(accessor, info, record, sessionId);
	logger.info("session-ttl", "Session TTL expiry finalized", {
		sessionKey: info.key,
		checkpointId,
		summaryJobId,
		transcriptChars: transcript.length,
	});
	return record;
}

/** Wire the tracker eviction hook to TTL finalization (daemon startup). */
export function registerSessionTtlFinalization(): void {
	setSessionExpirationHandler((info) => {
		finalizeExpiredSession(info);
	});
}
