/**
 * Prospective indexing worker — generates hypothetical future queries
 * ("hints") for each memory at write time. Hints are indexed in FTS5
 * so search matches memories by anticipated cue, bridging the semantic
 * gap between stored facts and natural language queries.
 *
 * Inspired by Kumiho (arXiv:2603.17244).
 */

import { type LlmProvider, type PipelineHintsConfig, scanMemoryContent } from "@signet/core";
import { DbWriteQueueFullError, type DbAccessor, type WriteDb } from "../db-accessor";
import { logger } from "../logger";
import type { PipelineV2Config } from "../memory-config";
import { isSystemPressureHigh } from "../system-pressure";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HintsWorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface HintJobRow {
	readonly id: string;
	readonly memory_id: string;
	readonly payload: string;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface HintPayload {
	readonly memoryId: string;
	readonly content: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(content: string, max: number): string {
	return [
		"Given this fact stored in a personal memory system:",
		`"${content}"`,
		"",
		`Generate ${max} diverse questions or cues a user might use in the future when this fact would be helpful. Include:`,
		`- Direct questions ("Where does X live?")`,
		`- Temporal questions ("When did X happen?")`,
		`- Relational questions ("Who is X's partner?")`,
		`- Indirect/conversational cues ("Tell me about X's move")`,
		"",
		"Return ONLY the questions, one per line. No numbering, no bullets.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Hint generation
// ---------------------------------------------------------------------------

const PROMPT_RESIDUE_PATTERNS = [
	/\bhowever\b/i,
	/\bbut note\b/i,
	/\balternatively\b/i,
	/\bthe problem says\b/i,
	/\bthe fact says\b/i,
	/\bdiverse questions?\b/i,
	/\bdiverse cues?\b/i,
	/\bwe need to\b/i,
	/\blet'?s\b/i,
	/\bmake sure\b/i,
];

const GENERIC_LABEL_CUE_PATTERNS = [
	/^(who requested|when|current status|what is the current status)\s*:/i,
	/^(direct|temporal|relational|indirect|conversational)\s*:/i,
];

/** Check if a line looks like a useful question or conversational cue (not prompt residue). */
function isHintLine(line: string): boolean {
	if (PROMPT_RESIDUE_PATTERNS.some((pattern) => pattern.test(line))) return false;
	if (GENERIC_LABEL_CUE_PATTERNS.some((pattern) => pattern.test(line))) return false;
	if (line.endsWith("?")) return true;
	// Conversational cues: "Tell me about...", "Describe...", etc.
	if (
		/^(tell|describe|explain|show|what|who|where|when|why|how|which|does|did|is|are|can|could|has|have|will|would)/i.test(
			line,
		)
	)
		return true;
	return false;
}

export async function generateHints(
	provider: LlmProvider,
	content: string,
	cfg: PipelineHintsConfig,
): Promise<readonly string[]> {
	if (!scanMemoryContent(content).contextEligible) return [];
	const prompt = buildPrompt(content, cfg.max);
	// Use higher token budget to accommodate thinking model overhead
	const raw = await provider.generate(prompt, {
		timeoutMs: cfg.timeout,
		maxTokens: Math.max(cfg.maxTokens, 1024),
	});
	// Strip <think>...</think> blocks (qwen3, deepseek, etc.)
	const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	const lines = stripped
		.split("\n")
		.map((l) =>
			l
				.replace(/^\d+[.)]\s*/, "")
				.replace(/^[-*]\s*/, "")
				.trim(),
		)
		.filter((l) => l.length > 10 && l.length < 300 && isHintLine(l));
	logger.debug("pipeline", "Hints generated", {
		rawLen: raw.length,
		parsed: lines.length,
	});
	return lines;
}

// ---------------------------------------------------------------------------
// Job leasing (same pattern as structural-classify)
// ---------------------------------------------------------------------------

function leaseJob(db: WriteDb, maxAttempts: number): HintJobRow | null {
	const now = new Date().toISOString();
	const epoch = Math.floor(Date.now() / 1000);

	const row = db
		.prepare(
			`SELECT id, memory_id, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = 'prospective_index'
			   AND status = 'pending'
			   AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(maxAttempts, epoch) as HintJobRow | undefined;

	if (!row) return null;

	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'leased', leased_at = ?, attempts = attempts + 1, updated_at = ?
		 WHERE id = ?`,
	).run(now, now, row.id);

	return { ...row, attempts: row.attempts + 1 };
}

function completeJob(db: WriteDb, jobId: string): void {
	const now = new Date().toISOString();
	db.prepare(`UPDATE memory_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(
		now,
		now,
		jobId,
	);
}

function failJob(db: WriteDb, jobId: string, error: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
		     leased_at = NULL, failed_at = ?, updated_at = ?,
		     payload = CASE WHEN json_valid(payload)
		                    THEN json_set(payload, '$.lastError', ?)
		                    ELSE payload END
		 WHERE id = ?`,
	).run(now, now, error, jobId);
}

/**
 * Release a leased job without relying on the transaction callback that just
 * failed. This is deliberately a single autocommit statement: it is the last
 * recovery boundary before the in-memory pending write is allowed to clear.
 */
function recoverFailedJob(db: WriteDb, jobId: string, error: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
		     leased_at = NULL, failed_at = ?, updated_at = ?,
		     payload = CASE WHEN json_valid(payload)
		                    THEN json_set(payload, '$.lastError', ?)
		                    ELSE payload END
		 WHERE id = ? AND status = 'leased'`,
	).run(now, now, error, jobId);
}

// ---------------------------------------------------------------------------
// Persist hints
// ---------------------------------------------------------------------------

function writeHints(db: WriteDb, memoryId: string, hints: readonly string[]): number {
	const memory = db.prepare("SELECT agent_id FROM memories WHERE id = ? AND is_deleted = 0").get(memoryId) as {
		agent_id?: unknown;
	} | null;
	if (typeof memory?.agent_id !== "string" || memory.agent_id.length === 0) return 0;
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	const now = new Date().toISOString();
	let inserted = 0;
	for (const hint of hints) {
		const id = crypto.randomUUID();
		stmt.run(id, memoryId, memory.agent_id, hint, now);
		inserted++;
	}
	return inserted;
}

function isRetryableWriteAdmissionError(error: unknown): boolean {
	// Queue admission pressure is the only error this worker can safely retry
	// without changing the leased job's state. Callback, transaction, timeout,
	// and cancellation errors must go through the job failure transition.
	return error instanceof DbWriteQueueFullError;
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export function startHintsWorker(deps: {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
}): HintsWorkerHandle {
	const { accessor, provider, pipelineCfg } = deps;
	const rawCfg = pipelineCfg.hints;
	if (!rawCfg?.enabled) {
		return { stop: async () => {}, running: false };
	}
	const cfg = rawCfg;

	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tickPromise: Promise<void> | null = null;
	let stopPromise: Promise<void> | null = null;
	type PendingWrite = {
		readonly kind: "completion" | "failure" | "recovery";
		readonly job: HintJobRow;
		readonly run: () => Promise<void>;
		readonly retryAt: number;
	};
	let pendingWrite: PendingWrite | null = null;

	async function executePendingWrite(write: PendingWrite): Promise<boolean> {
		if (write.retryAt > Date.now()) return false;
		try {
			await write.run();
			if (pendingWrite === write) pendingWrite = null;
			return true;
		} catch (error) {
			const retryable = isRetryableWriteAdmissionError(error);
			if (retryable) {
				if (pendingWrite === write) {
					pendingWrite = { ...write, retryAt: Date.now() + Math.max(cfg.poll, 25) };
				}
				logger.warn("pipeline", "Hints worker write admission deferred", {
					jobId: write.job.id,
					memoryId: write.job.memory_id,
					kind: write.kind,
					retryable: true,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (write.kind === "completion") {
				const message = error instanceof Error ? error.message : String(error);
				const failure: PendingWrite = {
					kind: "failure",
					job: write.job,
					run: async () => {
						await accessor.withWriteTxAsync(
							(db: import("../db-accessor").WriteDb) => failJob(db, write.job.id, message),
							{ siteToken: "pipeline/prospective-index.ts:283" },
						);
					},
					retryAt: 0,
				};
				pendingWrite = failure;
				await executePendingWrite(failure);
				return false;
			}
			if (write.kind === "failure") {
				const message = error instanceof Error ? error.message : String(error);
				const recovery: PendingWrite = {
					kind: "recovery",
					job: write.job,
					run: async () => {
						await accessor.withWriteDbAsync(
							(db: import("../db-accessor").WriteDb) => recoverFailedJob(db, write.job.id, message),
							{ siteToken: "pipeline/prospective-index.ts:293" },
						);
					},
					retryAt: 0,
				};
				pendingWrite = recovery;
				return executePendingWrite(recovery);
			}
			if (write.kind === "recovery") {
				if (pendingWrite === write) {
					pendingWrite = { ...write, retryAt: Date.now() + Math.max(cfg.poll, 25) };
				}
				logger.warn("pipeline", "Hints worker lease recovery deferred", {
					jobId: write.job.id,
					memoryId: write.job.memory_id,
					retryable: false,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (pendingWrite === write) pendingWrite = null;
			logger.warn("pipeline", "Hints worker write admission failed", {
				jobId: write.job.id,
				memoryId: write.job.memory_id,
				kind: write.kind,
				retryable: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	async function tick(): Promise<void> {
		if (!running) return;
		let job: HintJobRow | null = null;
		try {
			if (isSystemPressureHigh()) return;

			if (pendingWrite) {
				await executePendingWrite(pendingWrite);
				return;
			}

			job = await accessor.withWriteTxAsync((db: import("../db-accessor").WriteDb) => leaseJob(db, 3), {
				siteToken: "pipeline/prospective-index.ts:345",
			});
			if (!job) return;
			const j = job;

			let payload: HintPayload;
			try {
				payload = JSON.parse(j.payload) as HintPayload;
			} catch {
				const write: PendingWrite = {
					kind: "failure",
					job: j,
					run: async () => {
						await accessor.withWriteTxAsync(
							(db: import("../db-accessor").WriteDb) => failJob(db, j.id, "invalid payload"),
							{ siteToken: "pipeline/prospective-index.ts:359" },
						);
					},
					retryAt: 0,
				};
				pendingWrite = write;
				await executePendingWrite(write);
				return;
			}

			// Generate hints outside of any db lock
			const hints = await generateHints(provider, payload.content, cfg);

			if (hints.length > 0) {
				const write: PendingWrite = {
					kind: "completion",
					job: j,
					run: async () => {
						await accessor.withWriteTxAsync(
							(db: import("../db-accessor").WriteDb) => {
								writeHints(db, payload.memoryId, hints);
								completeJob(db, j.id);
							},
							{ siteToken: "pipeline/prospective-index.ts:379" },
						);
					},
					retryAt: 0,
				};
				pendingWrite = write;
				if (!(await executePendingWrite(write))) return;
				logger.info("pipeline", "Prospective hints generated", {
					memoryId: payload.memoryId,
					hints: hints.length,
				});
			} else {
				const write: PendingWrite = {
					kind: "completion",
					job: j,
					run: async () => {
						await accessor.withWriteTxAsync((db: import("../db-accessor").WriteDb) => completeJob(db, j.id), {
							siteToken: "pipeline/prospective-index.ts:400",
						});
					},
					retryAt: 0,
				};
				pendingWrite = write;
				if (!(await executePendingWrite(write))) return;
				logger.debug("pipeline", "No hints generated (empty LLM response)", {
					memoryId: payload.memoryId,
				});
			}
		} catch (e) {
			if (job) {
				const j = job;
				const msg = e instanceof Error ? e.message : String(e);
				const write: PendingWrite = {
					kind: "failure",
					job: j,
					run: async () => {
						await accessor.withWriteTxAsync((db: import("../db-accessor").WriteDb) => failJob(db, j.id, msg), {
							siteToken: "pipeline/prospective-index.ts:420",
						});
					},
					retryAt: 0,
				};
				pendingWrite = write;
				await executePendingWrite(write);
				logger.warn("pipeline", "Hints worker job failed", {
					jobId: j.id,
					memoryId: j.memory_id,
					error: msg,
					attempt: j.attempts,
				});
			}
			logger.warn("pipeline", "Hints worker tick failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			schedule();
		}
	}

	function schedule(): void {
		if (!running) return;
		timer = setTimeout(() => {
			const current = tick();
			tickPromise = current;
			void current.then(
				() => {
					if (tickPromise === current) tickPromise = null;
				},
				() => {
					if (tickPromise === current) tickPromise = null;
				},
			);
		}, cfg.poll);
	}

	async function drainPendingWrite(): Promise<void> {
		while (pendingWrite) {
			const write = pendingWrite;
			const waitMs = Math.max(0, write.retryAt - Date.now());
			if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
			if (pendingWrite !== write) continue;
			await executePendingWrite(write);
		}
	}

	// Start
	schedule();

	return {
		async stop() {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				running = false;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				if (tickPromise) await tickPromise;
				await drainPendingWrite();
			})();
			return stopPromise;
		},
		get running() {
			return running;
		},
	};
}

// ---------------------------------------------------------------------------
// Job enqueueing (called from extraction worker after memory write)
// ---------------------------------------------------------------------------

export function enqueueHintsJob(db: WriteDb, memoryId: string, content: string): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const payload = JSON.stringify({ memoryId, content } satisfies HintPayload);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
		 VALUES (?, ?, 'prospective_index', 'pending', ?, 0, 3, ?, ?)`,
	).run(id, memoryId, payload, now, now);
}
