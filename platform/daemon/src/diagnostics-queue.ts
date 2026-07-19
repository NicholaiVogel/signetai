/**
 * Queue breakdown helpers for the diagnostics module (issue #901).
 *
 * Split out of `diagnostics.ts` to keep both files under the ~700 LOC
 * guideline (CONTRIBUTING.md). The original module re-exports the public
 * surface so existing callers don't need to change their imports.
 */

import type { ReadDb } from "./db-accessor";

export interface QueueCounts {
	readonly pending: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	/** Age in seconds of the oldest non-terminal row (pending or leased). 0 when none. */
	readonly oldestAgeSec: number;
	/** Age in seconds of the oldest `dead` row. 0 when no dead rows. */
	readonly oldestDeadAgeSec: number;
	/** Most recent non-null `error` value seen on any row, or null when none. */
	readonly lastError: string | null;
}

export interface OldestDeadJob {
	readonly id: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly createdAt: string;
	readonly attempts: number;
	readonly error: string | null;
}

export type QueueSource = "memory" | "summary" | "extraction";

export interface QueueThresholds {
	readonly summaryDeadWarn: number;
	readonly summaryDeadFail: number;
	readonly summaryOldestPendingWarnSec: number;
	readonly summaryOldestPendingFailSec: number;
	readonly summaryOldestDeadWarnSec: number;
	readonly extractionDeadWarn: number;
	readonly extractionDeadFail: number;
}

export const DEFAULT_QUEUE_THRESHOLDS: QueueThresholds = {
	summaryDeadWarn: 50,
	summaryDeadFail: 500,
	summaryOldestPendingWarnSec: 300,
	summaryOldestPendingFailSec: 1800,
	summaryOldestDeadWarnSec: 86_400,
	extractionDeadWarn: 50,
	extractionDeadFail: 500,
};

function tableExists(db: ReadDb, name: string): boolean {
	const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
		| { name: string }
		| undefined;
	return typeof row === "object" && row !== null;
}

function ageSec(iso: string | null | undefined): number {
	if (typeof iso !== "string" || iso.length === 0) return 0;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return 0;
	return Math.max(0, (Date.now() - t) / 1000);
}

/**
 * Build a `QueueCounts` snapshot for a single logical queue.
 *
 * - `memory`: counts rows in `memory_jobs`.
 * - `summary`: counts rows in `summary_jobs`. Returns zeros if the table
 *   is absent (older databases or fresh installs before the migration).
 * - `extraction`: counts rows in `memory_jobs WHERE job_type = 'extract'`,
 *   the project's convention (see `platform/daemon/src/pipeline/extraction-queue.ts`).
 */
export function getQueueCounts(db: ReadDb, source: QueueSource): QueueCounts {
	const empty: QueueCounts = {
		pending: 0,
		leased: 0,
		completed: 0,
		failed: 0,
		dead: 0,
		oldestAgeSec: 0,
		oldestDeadAgeSec: 0,
		lastError: null,
	};

	if (source === "summary" && !tableExists(db, "summary_jobs")) {
		return empty;
	}

	const tableName = source === "summary" ? "summary_jobs" : "memory_jobs";
	const jobTypeFilter = source === "extraction" ? "AND job_type = 'extract'" : "";

	const countsRow = db
		.prepare(
			`SELECT
				SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN status = 'leased'    THEN 1 ELSE 0 END) AS leased,
				SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
				SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
				SUM(CASE WHEN status = 'dead'      THEN 1 ELSE 0 END) AS dead
			 FROM ${tableName}
			 WHERE 1=1 ${jobTypeFilter}`,
		)
		.get() as
		| {
				pending: number | null;
				leased: number | null;
				completed: number | null;
				failed: number | null;
				dead: number | null;
		  }
		| undefined;

	const oldestRow = db
		.prepare(`SELECT MIN(created_at) AS oldest FROM ${tableName} WHERE status IN ('pending','leased') ${jobTypeFilter}`)
		.get() as { oldest: string | null } | undefined;

	const oldestDeadRow = db
		.prepare(`SELECT MIN(created_at) AS oldest FROM ${tableName} WHERE status = 'dead' ${jobTypeFilter}`)
		.get() as { oldest: string | null } | undefined;

	const lastErrorRow = db
		.prepare(`SELECT error FROM ${tableName} WHERE error IS NOT NULL ${jobTypeFilter} ORDER BY rowid DESC LIMIT 1`)
		.get() as { error: string | null } | undefined;

	return {
		pending: countsRow?.pending ?? 0,
		leased: countsRow?.leased ?? 0,
		completed: countsRow?.completed ?? 0,
		failed: countsRow?.failed ?? 0,
		dead: countsRow?.dead ?? 0,
		oldestAgeSec: ageSec(oldestRow?.oldest),
		oldestDeadAgeSec: ageSec(oldestDeadRow?.oldest),
		lastError:
			typeof lastErrorRow?.error === "string" && lastErrorRow.error.length > 0
				? lastErrorRow.error.slice(0, 512)
				: null,
	};
}

/**
 * Find the oldest dead row in a single queue. Returns null when no dead
 * rows exist or when the table is missing (e.g. summary_jobs on a fresh
 * database before the migration runs).
 */
export function getOldestDeadJob(db: ReadDb, source: QueueSource): OldestDeadJob | null {
	if (source === "summary" && !tableExists(db, "summary_jobs")) {
		return null;
	}
	const tableName = source === "summary" ? "summary_jobs" : "memory_jobs";
	const jobTypeFilter = source === "extraction" ? "AND job_type = 'extract'" : "";

	try {
		const row = db
			.prepare(
				`SELECT id, harness, session_key AS sessionKey, created_at AS createdAt,
						attempts, error
				 FROM ${tableName}
				 WHERE status = 'dead' ${jobTypeFilter}
				 ORDER BY created_at ASC LIMIT 1`,
			)
			.get() as
			| {
					id: string;
					harness: string | null;
					sessionKey: string | null;
					createdAt: string;
					attempts: number | null;
					error: string | null;
			  }
			| undefined;

		if (!row) return null;
		return {
			id: row.id,
			harness: typeof row.harness === "string" ? row.harness : "unknown",
			sessionKey: typeof row.sessionKey === "string" ? row.sessionKey : null,
			createdAt: row.createdAt,
			attempts: typeof row.attempts === "number" ? row.attempts : 0,
			error: typeof row.error === "string" ? row.error : null,
		};
	} catch {
		// memory_jobs schema may not match (e.g. no session_key column on
		// older installs); degrade to a minimal record so callers still get
		// the id, attempts, error.
		try {
			const fallback = db
				.prepare(
					`SELECT id, created_at AS createdAt, attempts, error
					 FROM ${tableName}
					 WHERE status = 'dead' ${jobTypeFilter}
					 ORDER BY created_at ASC LIMIT 1`,
				)
				.get() as { id: string; createdAt: string; attempts: number | null; error: string | null } | undefined;
			if (!fallback) return null;
			return {
				id: fallback.id,
				harness: "unknown",
				sessionKey: null,
				createdAt: fallback.createdAt,
				attempts: typeof fallback.attempts === "number" ? fallback.attempts : 0,
				error: typeof fallback.error === "string" ? fallback.error : null,
			};
		} catch {
			return null;
		}
	}
}

export function scoreCountsWithThresholds(
	counts: QueueCounts,
	deadWarn: number,
	deadFail: number,
	oldestPendingWarnSec: number,
	oldestPendingFailSec: number,
): number {
	let score = 1.0;
	if (counts.dead >= deadFail) return 0;
	if (counts.dead >= deadWarn) score -= 0.4;
	if (counts.oldestAgeSec >= oldestPendingFailSec) score -= 0.5;
	else if (counts.oldestAgeSec >= oldestPendingWarnSec) score -= 0.2;
	if (score < 0) score = 0;
	if (score > 1) score = 1;
	return score;
}
