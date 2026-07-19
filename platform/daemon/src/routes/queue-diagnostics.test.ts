/**
 * Issue #901 — regression tests for /api/diagnostics/queue + repair.
 *
 * Uses an in-memory SQLite DB with real migrations so the queue
 * breakdowns read against production-shaped tables.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { cancelObsoleteJobs, createRateLimiter, pruneTerminalJobs, requeueDeadJobs } from "../repair-actions";
import { registerQueueDiagnosticsRoutes } from "./queue-diagnostics";

function makeAccessor(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (readDb: ReadDb) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (writeDb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		close(): void {},
	};
}

function seedDb(db: Database): void {
	const nowIso = new Date().toISOString();
	const oldIso = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
	const memRow = db
		.prepare(
			`INSERT INTO memories (id, type, content, confidence, tags, created_at, updated_at,
				updated_by, version, manual_override, is_deleted, embedding_model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.get("mem-1", "fact", "seed", 0.9, "[]", nowIso, nowIso, "test", 1, 0, 0, null) as { id: string } | undefined;
	if (!memRow) throw new Error("seed failed");

	db.prepare(
		`INSERT INTO memory_jobs (id, memory_id, job_type, status, attempts, max_attempts,
			created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-mem-1", memRow.id, "extract", "dead", 3, 3, oldIso, oldIso);

	db.prepare(
		`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status,
			attempts, max_attempts, created_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-sum-1", "session-A", "codex", "demo", "transcript", "dead", 3, 3, oldIso, "boom");
	db.prepare(
		`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status,
			attempts, max_attempts, created_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run("dead-sum-2", "session-B", "codex", "demo", "transcript", "dead", 3, 3, oldIso, null);
}

interface DbEnv {
	db: Database;
	accessor: DbAccessor;
	app: Hono;
}

function setup(): DbEnv {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	seedDb(db);
	const accessor = makeAccessor(db);
	const limiter = createRateLimiter();
	const app = new Hono();
	// Skip auth — the queue diagnostics module enforces admin via
	// requirePermission; replace with a no-op guard for tests.
	app.use("/api/diagnostics/queue", async (_c, next) => {
		await next();
	});
	app.use("/api/diagnostics/queue/repair", async (_c, next) => {
		await next();
	});
	registerQueueDiagnosticsRoutes(app, { accessor, limiter });
	return { db, accessor, app };
}

describe("/api/diagnostics/queue", () => {
	let env: DbEnv;
	beforeEach(() => {
		env = setup();
	});
	afterEach(() => {
		env.db.close();
	});

	it("returns per-queue counts, oldest deads, and thresholds", async () => {
		const res = await env.app.request("/api/diagnostics/queue");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			queues: { memory: { dead: number }; summary: { dead: number } };
			oldestDeadSummaryJob: { id: string } | null;
			thresholds: { summaryDeadWarn: number };
		};
		expect(body.queues.memory.dead).toBe(1);
		expect(body.queues.summary.dead).toBe(2);
		expect(body.oldestDeadSummaryJob?.id).toBe("dead-sum-1");
		expect(body.thresholds.summaryDeadWarn).toBe(50);
	});
});

describe("POST /api/diagnostics/queue/repair", () => {
	let env: DbEnv;
	beforeEach(() => {
		env = setup();
	});
	afterEach(() => {
		env.db.close();
	});

	it("dry-runs cancel by default and preserves source rows", async () => {
		const res = await env.app.request("/api/diagnostics/queue/repair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "cancel", tables: ["summary"] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			affected: number;
			preview: string[];
			totalMatching: number;
		};
		expect(body.success).toBe(true);
		expect(body.affected).toBe(0);
		expect(body.totalMatching).toBeGreaterThanOrEqual(1);
		// Source rows are untouched on dry-run
		const cnt = (
			env.db.prepare("SELECT COUNT(*) AS n FROM summary_jobs WHERE status = 'dead'").get() as {
				n: number;
			}
		).n;
		expect(cnt).toBe(2);
	});

	it("applies prune with --apply (dryRun: false) and archives rows", async () => {
		const res = await env.app.request("/api/diagnostics/queue/repair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "prune",
				dryRun: false,
				tables: ["summary"],
				retentionMs: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { affected: number; success: boolean };
		expect(body.success).toBe(true);
		expect(body.affected).toBeGreaterThanOrEqual(2);
		// Source rows gone, archive rows present
		const src = (env.db.prepare("SELECT COUNT(*) AS n FROM summary_jobs").get() as { n: number }).n;
		const arch = (
			env.db.prepare("SELECT COUNT(*) AS n FROM job_archive WHERE source_table = 'summary_jobs'").get() as { n: number }
		).n;
		expect(src).toBe(0);
		expect(arch).toBeGreaterThanOrEqual(2);
	});

	it("rejects invalid action with 400", async () => {
		const res = await env.app.request("/api/diagnostics/queue/repair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "explode" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("repair action integration via the new dispatch path", () => {
	it("requeueDeadJobs dry-run returns 0 affected and a preview", () => {
		const env = setup();
		try {
			const limiter = createRateLimiter();
			const result = requeueDeadJobs(
				env.accessor,
				{
					autonomous: { enabled: true, frozen: false },
					repair: { requeueCooldownMs: 0, requeueHourlyBudget: 100 },
				} as unknown as Parameters<typeof requeueDeadJobs>[1],
				{ reason: "test", actor: "test", actorType: "operator" },
				limiter,
				{ dryRun: true },
			);
			expect(result.action).toBe("requeueDeadJobs");
			expect(result.affected).toBe(0);
			expect(result.preview).toBeDefined();
			expect(result.totalMatching).toBeGreaterThanOrEqual(1);
		} finally {
			env.db.close();
		}
	});

	it("cancelObsoleteJobs apply moves dead summary rows to cancelled and writes audit row", () => {
		const env = setup();
		try {
			const limiter = createRateLimiter();
			const result = cancelObsoleteJobs(
				env.accessor,
				{
					autonomous: { enabled: true, frozen: false },
					repair: { requeueCooldownMs: 0, requeueHourlyBudget: 100 },
				} as unknown as Parameters<typeof cancelObsoleteJobs>[1],
				{ reason: "test", actor: "test", actorType: "operator" },
				limiter,
				{ tables: ["summary"], olderThanMs: 1 },
			);
			expect(result.action).toBe("cancelObsoleteJobs");
			expect(result.affected).toBeGreaterThanOrEqual(1);
			const cancelled = (
				env.db.prepare("SELECT COUNT(*) AS n FROM summary_jobs WHERE status = 'cancelled'").get() as { n: number }
			).n;
			const audit = (
				env.db.prepare("SELECT COUNT(*) AS n FROM job_cancellations WHERE source_table = 'summary_jobs'").get() as {
					n: number;
				}
			).n;
			expect(cancelled).toBeGreaterThanOrEqual(1);
			expect(audit).toBeGreaterThanOrEqual(1);
		} finally {
			env.db.close();
		}
	});

	it("pruneTerminalJobs apply archives then deletes", () => {
		const env = setup();
		try {
			const limiter = createRateLimiter();
			const result = pruneTerminalJobs(
				env.accessor,
				{
					autonomous: { enabled: true, frozen: false },
					repair: { requeueCooldownMs: 0, requeueHourlyBudget: 100 },
				} as unknown as Parameters<typeof pruneTerminalJobs>[1],
				{ reason: "test", actor: "test", actorType: "operator" },
				limiter,
				{ tables: ["summary"], retentionMs: 1 },
			);
			expect(result.action).toBe("pruneTerminalJobs");
			expect(result.affected).toBeGreaterThanOrEqual(1);
			const arch = (
				env.db.prepare("SELECT COUNT(*) AS n FROM job_archive WHERE source_table = 'summary_jobs'").get() as {
					n: number;
				}
			).n;
			const src = (env.db.prepare("SELECT COUNT(*) AS n FROM summary_jobs").get() as { n: number }).n;
			expect(arch).toBeGreaterThanOrEqual(1);
			expect(src).toBe(0);
		} finally {
			env.db.close();
		}
	});
});
