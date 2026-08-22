/**
 * Resumable full-database integrity verification for the migration backup
 * prune gate.
 *
 * SQLite documents that a table-scoped `PRAGMA integrity_check(tbl)` is NOT
 * equivalent to the global check: it cannot detect unused file sections,
 * pages claimed by multiple tables, or freelist damage (the freelist is only
 * verified while checking the schema table). The prune gate must therefore
 * be satisfied by the global `PRAGMA integrity_check` — one synchronous
 * native operation — run post-ready on the owner's maintenance lane.
 *
 * Resumability: the global check cannot be paused at a page boundary, so a
 * slice that runs out of its owner deadline retries from scratch on the next
 * scheduled slice with a larger deadline, up to a bounded cap. A completed
 * pass gates the backup prune; a partial pass never does. Progress and
 * failures are always surfaced.
 */

import type { DbOwnerClient } from "./db-owner-client";
import { ownerQueryAll, type DbOwnerMaintenanceMetrics } from "./db-owner-maintenance";

export interface MigrationVerifyResult {
	/** "pass" — global integrity_check returned a single "ok" row. */
	readonly phase: "pass" | "incomplete" | "failed";
	readonly messages: readonly string[];
	readonly elapsedMs: number;
	readonly attemptDeadlineMs: number;
}

export interface MigrationVerifyOptions {
	readonly owner: DbOwnerClient;
	/** Per-attempt owner deadline. Retries use min(cap, attempt * 2). */
	readonly attemptDeadlineMs?: number;
	readonly maxAttemptDeadlineMs?: number;
	readonly onProgress?: (result: MigrationVerifyResult) => void | Promise<void>;
}

const DEFAULT_ATTEMPT_DEADLINE_MS = 5_000;
const MAX_ATTEMPT_DEADLINE_MS = 55_000;

interface IntegrityCheckRow {
	readonly integrity_check?: unknown;
}

const text = (value: unknown): string => String(value ?? "");

/**
 * Run one global integrity_check attempt. Caller schedules retries while
 * `phase === "incomplete"`.
 */
export async function runMigrationIntegrityVerify(options: MigrationVerifyOptions): Promise<MigrationVerifyResult> {
	const attemptDeadlineMs = options.attemptDeadlineMs ?? DEFAULT_ATTEMPT_DEADLINE_MS;
	const maxAttemptDeadlineMs = options.maxAttemptDeadlineMs ?? MAX_ATTEMPT_DEADLINE_MS;
	const startedAt = Date.now();
	try {
		const rows = await ownerQueryAll<IntegrityCheckRow>(
			options.owner,
			"integrity.migration-verify.global",
			"PRAGMA integrity_check",
			[],
			{ deadlineMs: attemptDeadlineMs, estimatedWorkUnits: 64 },
		);
		const messages = rows.map((row) => text(row.integrity_check));
		const passed = messages.length === 1 && messages[0] === "ok";
		const result: MigrationVerifyResult = {
			phase: passed ? "pass" : "failed",
			messages,
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		return result;
	} catch (error) {
		// Deadline exhaustion (DbOwnerDeadlineError) means the single native
		// operation did not finish inside this attempt's window. That is an
		// incomplete pass — never a prune gate and never a silent wedge: the
		// caller retries with a larger deadline, and the backup stays.
		const message = error instanceof Error ? error.message : String(error);
		const isDeadline = message.includes("exceeded its deadline") || message.includes("DB_OWNER_DEADLINE");
		const result: MigrationVerifyResult = {
			phase: isDeadline ? "incomplete" : "failed",
			messages: [message],
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		if (!isDeadline) throw error;
		return result;
	}
}

/** Next attempt deadline: double, capped. */
export function nextMigrationVerifyDeadline(currentMs: number, maxMs = MAX_ATTEMPT_DEADLINE_MS): number {
	return Math.min(maxMs, Math.max(DEFAULT_ATTEMPT_DEADLINE_MS, currentMs * 2));
}
