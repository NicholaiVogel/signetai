/**
 * Bounded, observable global integrity verification for the migration backup
 * prune gate.
 *
 * SQLite's global `PRAGMA integrity_check` is one synchronous native operation
 * and cannot be paused at a page boundary. Each maintenance tick therefore
 * runs exactly one generous attempt. An incomplete attempt is persisted and
 * retried on a fixed interval; a pass is the only result that prunes the
 * rollback backup.
 */

import type { DbOwnerClient } from "./db-owner-client";
import { basename } from "node:path";
import {
	incrementMigrationVerifyAttempt,
	markMigrationVerifyTerminal,
	MIGRATION_VERIFY_FAILED_STATUS,
	MIGRATION_VERIFY_PARKED_STATUS,
	readMigrationVerifyCheckpoint,
	type MigrationVerifyCheckpoint,
} from "./incremental-database-integrity";
import { ownerQueryAll } from "./db-owner-maintenance";

export const MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS = 300_000;
export const MIGRATION_VERIFY_RETRY_INTERVAL_MS = 30 * 60_000;
export const MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS = 8;
export const MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS = 3;
const MIGRATION_VERIFY_SCAN_BYTES_PER_SECOND = 10 * 1024 * 1024;
const MIGRATION_VERIFY_MAX_ATTEMPT_DEADLINE_MS = 15 * 60_000;
export { MIGRATION_VERIFY_PARKED_STATUS, MIGRATION_VERIFY_FAILED_STATUS };

export interface MigrationVerifyResult {
	/** "pass" — global integrity_check returned a single "ok" row. */
	readonly phase: "pass" | "incomplete" | "failed";
	readonly messages: readonly string[];
	readonly elapsedMs: number;
	readonly attemptDeadlineMs: number;
}

export interface MigrationVerifyOptions {
	readonly owner: DbOwnerClient;
	/** Per-attempt owner deadline. Production derives this from the database size. */
	readonly attemptDeadlineMs?: number;
	readonly onProgress?: (result: MigrationVerifyResult) => void | Promise<void>;
}

export function migrationVerifyAttemptDeadlineMs(databaseSizeBytes: number): number {
	const sizeBytes = Number.isFinite(databaseSizeBytes) ? Math.max(0, databaseSizeBytes) : 0;
	const sizeAllowanceMs = Math.ceil(sizeBytes / MIGRATION_VERIFY_SCAN_BYTES_PER_SECOND) * 1000;
	return Math.min(MIGRATION_VERIFY_MAX_ATTEMPT_DEADLINE_MS, MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS + sizeAllowanceMs);
}

interface IntegrityCheckRow {
	readonly integrity_check?: unknown;
}

const text = (value: unknown): string => String(value ?? "");

type SqliteErrorCode = string | number;

function sqliteErrorCode(error: unknown): SqliteErrorCode | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	const value = record.sqliteCode ?? record.code;
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isSqliteCorruptionCode(code: SqliteErrorCode): boolean {
	if (typeof code === "number") return code === 11 || code === 26;
	const normalized = code.toUpperCase();
	return (
		normalized === "11" ||
		normalized === "26" ||
		normalized.startsWith("SQLITE_CORRUPT") ||
		normalized === "SQLITE_NOTADB"
	);
}

/** Run one global integrity_check attempt on the owner's maintenance lane. */
export async function runMigrationIntegrityVerify(options: MigrationVerifyOptions): Promise<MigrationVerifyResult> {
	const attemptDeadlineMs = options.attemptDeadlineMs ?? MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS;
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
		const result: MigrationVerifyResult = {
			phase: messages.length === 1 && messages[0] === "ok" ? "pass" : "failed",
			messages,
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const normalizedMessage = message.toLowerCase();
		const isDeadline = message.includes("exceeded its deadline") || message.includes("DB_OWNER_DEADLINE");
		const code = sqliteErrorCode(error);
		const isRecognizedCorruption =
			code === undefined
				? ["database disk image is malformed", "file is not a database", "database disk image malformed"].some(
						(signature) => normalizedMessage.includes(signature),
					)
				: isSqliteCorruptionCode(code);
		const result: MigrationVerifyResult = {
			phase: isDeadline || !isRecognizedCorruption ? "incomplete" : "failed",
			messages: [message],
			elapsedMs: Date.now() - startedAt,
			attemptDeadlineMs,
		};
		await options.onProgress?.(result);
		return result;
	}
}

export interface MigrationVerifyCheckpointStore {
	readonly read: () => Promise<MigrationVerifyCheckpoint>;
	readonly incrementIncompleteAttempt: () => Promise<number>;
	readonly markTerminal: (
		status: typeof MIGRATION_VERIFY_PARKED_STATUS | typeof MIGRATION_VERIFY_FAILED_STATUS | "complete",
	) => Promise<void>;
}

export interface MigrationVerifyGateOptions {
	readonly owner: DbOwnerClient;
	/** Completed backup generation this gate is verifying. */
	readonly backupPath: string;
	/** Optional stat result for tests or callers that already have the file size. */
	readonly databaseSizeBytes?: number;
	readonly checkpointStore?: MigrationVerifyCheckpointStore;
	readonly runAttempt?: () => Promise<MigrationVerifyResult>;
	readonly pruneBackup: () => void | Promise<void>;
	readonly scheduleNextAttempt?: (callback: () => void, delayMs: number) => void;
	readonly onProgress?: (result: MigrationVerifyResult) => void | Promise<void>;
	readonly publishStatus?: (state: "healthy" | "corrupt" | "degraded", messages?: readonly string[]) => void;
	readonly log?: (message: string, details?: Record<string, unknown>) => void;
	readonly onContinuationRejection?: (callback: () => Promise<unknown>, error: unknown) => void;
}

export interface MigrationVerifyGateResult {
	readonly phase: MigrationVerifyResult["phase"] | "parked" | "terminal";
	readonly attemptCount: number;
	readonly scheduled: boolean;
}

function defaultScheduleNextAttempt(callback: () => void): void {
	const timer = setTimeout(callback, MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
}

export function migrationVerifyCheckpointKey(backupPath: string): string {
	return `database.migration-verify:${basename(backupPath)}`;
}

function ownerCheckpointStore(owner: DbOwnerClient, backupPath: string): MigrationVerifyCheckpointStore {
	const checkpointKey = migrationVerifyCheckpointKey(backupPath);
	return {
		read: () => readMigrationVerifyCheckpoint(owner, checkpointKey, 5_000),
		incrementIncompleteAttempt: () => incrementMigrationVerifyAttempt(owner, checkpointKey, 5_000),
		markTerminal: (status) => markMigrationVerifyTerminal(owner, status, checkpointKey, 5_000),
	};
}

export interface MigrationVerifySetupRetryOptions {
	readonly run: () => Promise<unknown>;
	readonly publishStatus?: (state: "degraded", messages: readonly string[]) => void;
	readonly scheduleNextAttempt?: (callback: () => void, delayMs: number) => void;
	readonly logWarn?: (message: string, details: Record<string, unknown>) => void;
	readonly logError?: (message: string, error: Error, details: Record<string, unknown>) => void;
}

export interface MigrationVerifySetupRetryController {
	readonly run: () => void;
	readonly handleRejection: (callback: () => Promise<unknown>, error: unknown) => void;
}

/** Share the bounded setup-rejection policy between the first run and continuations. */
export function createMigrationVerifySetupRetry(
	options: MigrationVerifySetupRetryOptions,
): MigrationVerifySetupRetryController {
	const schedule = options.scheduleNextAttempt ?? defaultScheduleNextAttempt;
	let rejectionAttempts = 0;

	const handleRejection = (callback: () => Promise<unknown>, error: unknown): void => {
		const attemptCount = rejectionAttempts + 1;
		rejectionAttempts = attemptCount;
		const rejectionError = error instanceof Error ? error : new Error(String(error));
		options.publishStatus?.("degraded", ["degraded:integrity-unverified"]);
		if (attemptCount >= MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS) {
			options.logError?.("Migration integrity verify setup rejected; retry cap reached", rejectionError, {
				attemptCount,
				maxAttempts: MIGRATION_VERIFY_SETUP_REJECTION_MAX_ATTEMPTS,
			});
			return;
		}
		options.logWarn?.("Migration integrity verify setup rejected; retry scheduled", {
			attemptCount,
			retryDelayMs: MIGRATION_VERIFY_RETRY_INTERVAL_MS,
			error: rejectionError.message,
		});
		schedule(() => run(callback), MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	};
	const run = (callback: () => Promise<unknown>): void => {
		void Promise.resolve()
			.then(callback)
			.then(() => {
				rejectionAttempts = 0;
			})
			.catch((error: unknown) => handleRejection(callback, error));
	};

	return {
		run: () => run(options.run),
		handleRejection,
	};
}

/**
 * Process one maintenance tick. The continuation is deliberately scheduled
 * only after an incomplete attempt, and never runs a tight retry loop.
 */
export async function runMigrationIntegrityVerifyGate(
	options: MigrationVerifyGateOptions,
): Promise<MigrationVerifyGateResult> {
	const store = options.checkpointStore ?? ownerCheckpointStore(options.owner, options.backupPath);
	const checkpoint = await store.read();
	if (checkpoint.status === MIGRATION_VERIFY_PARKED_STATUS || checkpoint.status === MIGRATION_VERIFY_FAILED_STATUS) {
		options.publishStatus?.(
			checkpoint.status === MIGRATION_VERIFY_FAILED_STATUS ? "corrupt" : "degraded",
			checkpoint.status === MIGRATION_VERIFY_FAILED_STATUS
				? ["global integrity verification previously failed"]
				: ["degraded:integrity-unverified"],
		);
		options.log?.("Migration integrity verify terminal state retained", {
			phase: checkpoint.status,
			attemptCount: checkpoint.attemptCount,
		});
		return { phase: "terminal", attemptCount: checkpoint.attemptCount, scheduled: false };
	}

	options.publishStatus?.("degraded", ["degraded:integrity-unverified"]);
	const attemptDeadlineMs = migrationVerifyAttemptDeadlineMs(options.databaseSizeBytes ?? 0);

	// Count the attempt before starting integrity_check. The check can occupy
	// the maintenance lane until its owner deadline, so persisting afterward
	// can queue behind the very work whose incomplete result must be retried.
	const attemptCount = await store.incrementIncompleteAttempt();
	const result = await (
		options.runAttempt ??
		(() =>
			runMigrationIntegrityVerify({
				owner: options.owner,
				attemptDeadlineMs,
				onProgress: options.onProgress,
			}))
	)();
	if (options.runAttempt !== undefined) await options.onProgress?.(result);

	if (result.phase === "pass") {
		try {
			await options.pruneBackup();
		} catch (error) {
			options.log?.("Global integrity check passed but rollback backup prune failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		await store.markTerminal("complete");
		options.publishStatus?.("healthy");
		options.log?.("Global integrity check passed; rollback backup pruned", { elapsedMs: result.elapsedMs });
		return { phase: "pass", attemptCount, scheduled: false };
	}
	if (result.phase === "failed") {
		// Publish the confirmed corruption before touching the checkpoint. A
		// corrupt database or rejected owner must not erase the verdict that
		// callers use to fail readiness closed.
		options.publishStatus?.("corrupt", result.messages);
		try {
			await store.markTerminal(MIGRATION_VERIFY_FAILED_STATUS);
		} catch (error) {
			options.log?.("Global integrity check failed; terminal checkpoint persistence rejected", {
				error: error instanceof Error ? error.message : String(error),
				status: MIGRATION_VERIFY_FAILED_STATUS,
			});
			// Re-throw so the existing setup-retry controller retries terminal
			// persistence; the corruption publication above remains durable in
			// the process even when the checkpoint write is unavailable.
			throw error;
		}
		options.log?.("Global integrity check FAILED; rollback backup retained", {
			messages: result.messages,
			elapsedMs: result.elapsedMs,
		});
		return { phase: "failed", attemptCount, scheduled: false };
	}

	options.log?.("degraded:integrity-unverified", {
		attemptCount,
		rollbackBackup: "retained",
	});
	if (attemptCount >= MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS) {
		await store.markTerminal(MIGRATION_VERIFY_PARKED_STATUS);
		options.log?.("degraded:integrity-unverified", {
			attemptCount,
			rollbackBackup: "retained",
			operatorSignal: true,
		});
		return { phase: "parked", attemptCount, scheduled: false };
	}

	const schedule = options.scheduleNextAttempt ?? defaultScheduleNextAttempt;
	const continuation = (): Promise<unknown> => runMigrationIntegrityVerifyGate(options);
	schedule(() => {
		void continuation().catch((error) => {
			if (options.onContinuationRejection !== undefined) {
				options.onContinuationRejection(continuation, error);
				return;
			}
			options.log?.("Migration integrity verify continuation rejected", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}, MIGRATION_VERIFY_RETRY_INTERVAL_MS);
	options.log?.("Migration integrity verify incomplete; next attempt scheduled", {
		attemptCount,
		intervalMs: MIGRATION_VERIFY_RETRY_INTERVAL_MS,
		elapsedMs: result.elapsedMs,
	});
	return { phase: "incomplete", attemptCount, scheduled: true };
}
