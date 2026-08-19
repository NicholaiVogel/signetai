/**
 * Checkpointed database integrity maintenance.
 *
 * SQLite's global `PRAGMA quick_check` is one synchronous native operation and
 * cannot be paused at a page boundary. The maintenance path therefore checks
 * one user table per owner job, commits its frontier, and yields back to the
 * owner queue before checking the next table. The existing global check stays
 * available to explicit operator repair flows, but is not used after readiness.
 * Every request goes through the maintenance helpers, so the owner-lane-classes
 * integration can move this work to its maintenance queue without changing the
 * checkpoint protocol.
 */

import { DbOwnerDeadlineError, type DbOwnerClient } from "./db-owner-client";
import { ownerQueryOne, ownerTransaction, ownerRunStatement } from "./db-owner-maintenance";

const CHECKPOINT_TABLE = "db_integrity_checkpoints";
const DEFAULT_CHECKPOINT_KEY = "database.quick-check";
const DEFAULT_TABLES_PER_RUN = 8;
const MAX_TABLES_PER_RUN = 64;
const DEFAULT_OWNER_DEADLINE_MS = 1_000;
const MAX_OWNER_DEADLINE_MS = 5_000;
const DEFAULT_RUN_BUDGET_MS = 5_000;
const MAX_RUN_BUDGET_MS = 60_000;
const DEFAULT_WORK_UNITS = 8;
const MAX_WORK_UNITS = 64;

export type IncrementalIntegrityPhase = "running" | "complete" | "cancelled" | "timed_out" | "unavailable";

export interface IncrementalIntegrityProgress {
	readonly checkpointKey: string;
	readonly phase: IncrementalIntegrityPhase;
	readonly checkedTables: number;
	readonly failedTables: number;
	readonly remainingTables: number;
	readonly lastTable: string | null;
	readonly pagesChecked: number;
	readonly bytesChecked: number;
	readonly elapsedMs: number;
	readonly ownerQueueWaitMs: number;
	readonly ownerLaneOccupancyMs: number;
	readonly memoryRssBytes: number;
	readonly cancellationReason: string | null;
}

export interface IncrementalIntegrityResult extends IncrementalIntegrityProgress {
	readonly errors: readonly string[];
}

export interface IncrementalIntegrityOptions {
	readonly owner: DbOwnerClient;
	readonly checkpointKey?: string;
	readonly tablesPerRun?: number;
	readonly ownerDeadlineMs?: number;
	readonly runBudgetMs?: number;
	readonly maxWorkUnits?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: IncrementalIntegrityProgress) => void | Promise<void>;
}

interface Checkpoint {
	readonly cursor: string;
	readonly checkedTables: number;
	readonly failedTables: number;
	readonly pagesChecked: number;
	readonly bytesChecked: number;
	readonly status: "running" | "complete";
}

interface TableRow {
	readonly name: string;
}

interface NumberRow {
	readonly value?: unknown;
}

interface PageCountRow {
	readonly page_count?: unknown;
	readonly page_size?: unknown;
}

interface QuickCheckRow {
	readonly quick_check?: unknown;
}

function boundedString(value: string | undefined): string {
	const key = value?.trim() || DEFAULT_CHECKPOINT_KEY;
	if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new RangeError("invalid integrity checkpoint key");
	return key;
}

function boundedPositive(value: number | undefined, defaultValue: number, maximum: number, label: string): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
	return Math.min(maximum, Math.floor(value));
}

function boundedTables(value: number | undefined): number {
	return boundedPositive(value, DEFAULT_TABLES_PER_RUN, MAX_TABLES_PER_RUN, "integrity table budget");
}

function boundedWorkUnits(value: number | undefined): number {
	return boundedPositive(value, DEFAULT_WORK_UNITS, MAX_WORK_UNITS, "integrity work budget");
}

function escapeIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function scalar(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function isDeadline(error: unknown): boolean {
	return error instanceof DbOwnerDeadlineError || (error instanceof Error && error.name === "DbOwnerDeadlineError");
}

async function ensureCheckpoint(owner: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.ensure",
		[
			ownerRunStatement(
				`CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
					checkpoint_key TEXT PRIMARY KEY,
					cursor TEXT NOT NULL DEFAULT '',
					checked_tables INTEGER NOT NULL DEFAULT 0,
					failed_tables INTEGER NOT NULL DEFAULT 0,
					pages_checked INTEGER NOT NULL DEFAULT 0,
					bytes_checked INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'running',
					updated_at TEXT NOT NULL
				)`,
			),
			ownerRunStatement(
				`INSERT OR IGNORE INTO ${CHECKPOINT_TABLE}
					(checkpoint_key, cursor, checked_tables, failed_tables, pages_checked, bytes_checked, status, updated_at)
					VALUES (?, '', 0, 0, 0, 0, 'running', ?)`,
				[key, new Date().toISOString()],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
}

async function readCheckpoint(owner: DbOwnerClient, key: string, deadlineMs: number): Promise<Checkpoint> {
	const row = await ownerQueryOne<Checkpoint>(
		owner,
		"integrity.checkpoint.read",
		`SELECT cursor, checked_tables AS checkedTables, failed_tables AS failedTables,
			pages_checked AS pagesChecked, bytes_checked AS bytesChecked, status
		 FROM ${CHECKPOINT_TABLE} WHERE checkpoint_key = ?`,
		[key],
		{ deadlineMs },
	);
	if (row === undefined || (row.status !== "running" && row.status !== "complete") || typeof row.cursor !== "string") {
		throw new Error(`integrity checkpoint ${key} is missing or invalid`);
	}
	return row;
}

async function resetCompleteCheckpoint(owner: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.reset",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = '', checked_tables = 0, failed_tables = 0,
				     pages_checked = 0, bytes_checked = 0, status = 'running', updated_at = ?
				 WHERE checkpoint_key = ?`,
				[new Date().toISOString(), key],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
}

async function readPageMetrics(
	owner: DbOwnerClient,
	deadlineMs: number,
): Promise<{ readonly pages: number; readonly bytes: number }> {
	const pageCount = await ownerQueryOne<PageCountRow>(owner, "integrity.page-count", "PRAGMA page_count", [], {
		deadlineMs,
	});
	const pageSize = await ownerQueryOne<PageCountRow>(owner, "integrity.page-size", "PRAGMA page_size", [], {
		deadlineMs,
	});
	const pages = scalar(pageCount?.page_count);
	return { pages, bytes: pages * scalar(pageSize?.page_size) };
}

async function nextTable(owner: DbOwnerClient, cursor: string, deadlineMs: number): Promise<TableRow | undefined> {
	return await ownerQueryOne<TableRow>(
		owner,
		"integrity.tables.next",
		`SELECT name FROM sqlite_schema
		 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		   AND name <> ? AND name > ?
		 ORDER BY name LIMIT ?`,
		[CHECKPOINT_TABLE, cursor, 1],
		{ deadlineMs },
	);
}

async function remainingTables(owner: DbOwnerClient, cursor: string, deadlineMs: number): Promise<number> {
	const row = await ownerQueryOne<NumberRow>(
		owner,
		"integrity.tables.remaining",
		`SELECT COUNT(*) AS value FROM sqlite_schema
		 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		   AND name <> ? AND name > ?`,
		[CHECKPOINT_TABLE, cursor],
		{ deadlineMs },
	);
	return scalar(row?.value);
}

async function persistTable(
	owner: DbOwnerClient,
	key: string,
	table: string,
	checkpoint: Checkpoint,
	metrics: { readonly pages: number; readonly bytes: number },
	failed: boolean,
	deadlineMs: number,
): Promise<Checkpoint> {
	const next: Checkpoint = {
		cursor: table,
		checkedTables: checkpoint.checkedTables + 1,
		failedTables: checkpoint.failedTables + (failed ? 1 : 0),
		pagesChecked: checkpoint.pagesChecked + metrics.pages,
		bytesChecked: checkpoint.bytesChecked + metrics.bytes,
		status: "running",
	};
	await ownerTransaction(
		owner,
		"integrity.checkpoint.commit",
		[
			ownerRunStatement(
				`UPDATE ${CHECKPOINT_TABLE}
				 SET cursor = ?, checked_tables = ?, failed_tables = ?, pages_checked = ?,
				     bytes_checked = ?, status = 'running', updated_at = ?
				 WHERE checkpoint_key = ? AND cursor = ?`,
				[
					next.cursor,
					next.checkedTables,
					next.failedTables,
					next.pagesChecked,
					next.bytesChecked,
					new Date().toISOString(),
					key,
					checkpoint.cursor,
				],
			),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
	return next;
}

async function markComplete(owner: DbOwnerClient, key: string, deadlineMs: number): Promise<void> {
	await ownerTransaction(
		owner,
		"integrity.checkpoint.complete",
		[
			ownerRunStatement(`UPDATE ${CHECKPOINT_TABLE} SET status = 'complete', updated_at = ? WHERE checkpoint_key = ?`, [
				new Date().toISOString(),
				key,
			]),
		],
		{ deadlineMs, estimatedWorkUnits: 1 },
	);
}

function progressFrom(
	key: string,
	phase: IncrementalIntegrityPhase,
	checkpoint: Checkpoint,
	remaining: number,
	lastTable: string | null,
	elapsedMs: number,
	ownerQueueWaitMs: number,
	ownerLaneOccupancyMs: number,
	cancellationReason: string | null,
): IncrementalIntegrityProgress {
	return {
		checkpointKey: key,
		phase,
		checkedTables: checkpoint.checkedTables,
		failedTables: checkpoint.failedTables,
		remainingTables: remaining,
		lastTable,
		pagesChecked: checkpoint.pagesChecked,
		bytesChecked: checkpoint.bytesChecked,
		elapsedMs,
		ownerQueueWaitMs,
		ownerLaneOccupancyMs,
		memoryRssBytes: process.memoryUsage().rss,
		cancellationReason,
	};
}

/** Run at most one bounded maintenance slice and leave a durable resume point. */
export async function runIncrementalDatabaseIntegrityCheck(
	options: IncrementalIntegrityOptions,
): Promise<IncrementalIntegrityResult> {
	const key = boundedString(options.checkpointKey);
	const tablesPerRun = Math.min(boundedTables(options.tablesPerRun), boundedWorkUnits(options.maxWorkUnits));
	const ownerDeadlineMs = boundedPositive(
		options.ownerDeadlineMs,
		DEFAULT_OWNER_DEADLINE_MS,
		MAX_OWNER_DEADLINE_MS,
		"integrity owner deadline",
	);
	const runBudgetMs = boundedPositive(
		options.runBudgetMs,
		DEFAULT_RUN_BUDGET_MS,
		MAX_RUN_BUDGET_MS,
		"integrity run budget",
	);
	const startedAt = Date.now();
	let queueWaitMs = 0;
	let ownerOccupancyMs = 0;
	let phase: IncrementalIntegrityPhase = "running";
	let cancellationReason: string | null = null;
	let checkpoint: Checkpoint = {
		cursor: "",
		checkedTables: 0,
		failedTables: 0,
		pagesChecked: 0,
		bytesChecked: 0,
		status: "running",
	};
	let lastTable: string | null = null;
	const errors: string[] = [];
	const emit = async (phase: IncrementalIntegrityPhase, reason: string | null): Promise<void> => {
		const remaining = await remainingTables(options.owner, checkpoint.cursor, ownerDeadlineMs).catch(() => 0);
		await options.onProgress?.(
			progressFrom(
				key,
				phase,
				checkpoint,
				remaining,
				lastTable,
				Date.now() - startedAt,
				queueWaitMs,
				ownerOccupancyMs,
				reason,
			),
		);
	};
	const progressSnapshot = async (): Promise<IncrementalIntegrityProgress> => {
		const remaining = await remainingTables(options.owner, checkpoint.cursor, ownerDeadlineMs).catch(() => 0);
		return progressFrom(
			key,
			phase,
			checkpoint,
			remaining,
			lastTable,
			Date.now() - startedAt,
			queueWaitMs,
			ownerOccupancyMs,
			cancellationReason,
		);
	};

	try {
		const setupStartedAt = Date.now();
		await ensureCheckpoint(options.owner, key, ownerDeadlineMs);
		ownerOccupancyMs += Date.now() - setupStartedAt;
		checkpoint = await readCheckpoint(options.owner, key, ownerDeadlineMs);
		if (checkpoint.status === "complete") {
			await resetCompleteCheckpoint(options.owner, key, ownerDeadlineMs);
			checkpoint = await readCheckpoint(options.owner, key, ownerDeadlineMs);
		}
		await emit("running", null);

		let processedInRun = 0;
		while (processedInRun < tablesPerRun) {
			if (options.signal?.aborted) {
				phase = "cancelled";
				cancellationReason = "aborted before the next table checkpoint";
				await emit("cancelled", "aborted before the next table checkpoint");
				return { ...(await progressSnapshot()), errors };
			}
			if (Date.now() - startedAt >= runBudgetMs) {
				phase = "timed_out";
				cancellationReason = "maintenance run budget exhausted at a table checkpoint";
				await emit("timed_out", "maintenance run budget exhausted at a table checkpoint");
				return { ...(await progressSnapshot()), errors };
			}
			const queryStartedAt = Date.now();
			const table = await nextTable(options.owner, checkpoint.cursor, ownerDeadlineMs);
			queueWaitMs += Math.max(0, Date.now() - queryStartedAt);
			if (table === undefined) {
				await markComplete(options.owner, key, ownerDeadlineMs);
				checkpoint = { ...checkpoint, status: "complete" };
				phase = "complete";
				await emit("complete", null);
				return { ...(await progressSnapshot()), errors };
			}
			lastTable = table.name;
			const scanStartedAt = Date.now();
			const row = await ownerQueryOne<QuickCheckRow>(
				options.owner,
				"integrity.quick-check.table",
				`PRAGMA quick_check(${escapeIdentifier(table.name)})`,
				[],
				{ deadlineMs: ownerDeadlineMs, estimatedWorkUnits: 1 },
			);
			ownerOccupancyMs += Date.now() - scanStartedAt;
			const message = text(row?.quick_check);
			const failed = message !== "ok";
			if (failed && message.length > 0) errors.push(`${table.name}: ${message}`);
			const metricStartedAt = Date.now();
			const metrics = await readPageMetrics(options.owner, ownerDeadlineMs);
			ownerOccupancyMs += Date.now() - metricStartedAt;
			checkpoint = await persistTable(options.owner, key, table.name, checkpoint, metrics, failed, ownerDeadlineMs);
			processedInRun += 1;
			await emit("running", null);
		}
		const remaining = await remainingTables(options.owner, checkpoint.cursor, ownerDeadlineMs);
		if (remaining === 0) {
			await markComplete(options.owner, key, ownerDeadlineMs);
			checkpoint = { ...checkpoint, status: "complete" };
			phase = "complete";
			await emit("complete", null);
			return { ...(await progressSnapshot()), errors };
		}
		cancellationReason = "maintenance table budget exhausted at a table checkpoint";
		await emit("running", cancellationReason);
		return { ...(await progressSnapshot()), errors };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		phase = isDeadline(error) ? "timed_out" : "unavailable";
		cancellationReason = reason;
		await emit(phase, reason);
		return { ...(await progressSnapshot()), errors: [...errors, reason] };
	}
}

export const INCREMENTAL_INTEGRITY_CHECKPOINT_TABLE = CHECKPOINT_TABLE;
