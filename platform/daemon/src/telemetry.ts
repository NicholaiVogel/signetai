/**
 * Anonymous, opt-in telemetry collector for the Signet daemon.
 *
 * Records events to an in-memory buffer, periodically flushing to
 * SQLite (always) and a self-hosted PostHog instance (when configured).
 * No memory content, user identity, or file paths are ever included.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PipelineTelemetryConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Open telemetry log (issue #1026 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Default location of the open telemetry log: one JSON line per recorded
 * event, so users can inspect exactly what was sent. Configurable via
 * `telemetryLogPath` on the collector; derived from the agents base path.
 */
export function defaultTelemetryLogPath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "telemetry", "events.jsonl");
}

function appendToTelemetryLog(logPath: string | null, line: string): void {
	if (!logPath) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${line}\n`, "utf-8");
	} catch {
		// Telemetry must never break the daemon. Best-effort only.
	}
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export const TELEMETRY_EVENTS = [
	"llm.generate",
	"pipeline.extraction",
	"pipeline.decision",
	"pipeline.embedding",
	"pipeline.error",
	"inference.route",
	"inference.execute",
	"inference.stream",
	"inference.fallback",
	"session.start",
	"session.end",
	"daemon.heartbeat",
	// Lifecycle events (issue #1026 Phase 2): fired when the user has opted
	// into anonymous telemetry. No PII, no code, no memory content.
	"daemon.started",
	"install.activated",
	"dreaming.pass",
	"command.invoked",
	"error.occurred",
	"version.upgraded",
	// Cloud events (issue #1207): declared now so the future cloud-connect
	// layer inherits the typed contract instead of retrofitting it. Nothing
	// emits them until the Signet Cloud surface exists. Same anonymous
	// contract — no credentials, account identifiers, or content.
	"cloud.connect_attempt",
	"cloud.sync",
	"cloud.storage",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENTS)[number];

export type TelemetryProperties = Readonly<Record<string, string | number | boolean | null>>;

export interface TelemetryEvent {
	readonly id: string;
	readonly event: TelemetryEventType;
	readonly timestamp: string;
	readonly properties: TelemetryProperties;
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

export interface TelemetryCollector {
	record(event: TelemetryEventType, properties: TelemetryProperties): void;

	flush(): Promise<void>;
	start(): void;
	stop(): Promise<void>;

	query(opts?: {
		event?: TelemetryEventType;
		since?: string;
		until?: string;
		limit?: number;
	}): readonly TelemetryEvent[];

	readonly enabled: boolean;

	/**
	 * Hash an agent id with the per-install id so inference telemetry never
	 * carries the raw agent name: stable within an install, not joinable
	 * across installs, not reversible. Returns "" when no install id exists.
	 */
	anonymizeAgentId(agentId: string): string;
}

// ---------------------------------------------------------------------------
// Active collector reference
// ---------------------------------------------------------------------------
// Mirrored here by the daemon for pipeline and hooks layers, which are not
// route modules and therefore don't read the route-layer ref in routes/state.

let activeCollector: TelemetryCollector | undefined;

export function setActiveTelemetry(collector: TelemetryCollector | undefined): void {
	activeCollector = collector;
}

export function getActiveTelemetry(): TelemetryCollector | undefined {
	return activeCollector;
}

/**
 * True when the process environment disables telemetry. The same
 * SIGNET_TELEMETRY_OPTOUT knob the install ping honors (issue #1026) so one
 * switch opts a whole machine or CI runner out — without touching config.
 */
export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SIGNET_TELEMETRY_OPTOUT === "1" || env.SIGNET_TELEMETRY_OPTOUT === "true";
}

/**
 * Resolve the anonymous per-install identifier, creating and persisting it on
 * first use. Falls back to an in-memory id if the database is unusable.
 * A truthy guard is required here: bun:sqlite returns null for a missing row
 * while better-sqlite3 returns undefined (dual-DB daemon).
 *
 * `created` is true only when the id was actually inserted — the daemon uses
 * it to emit install.activated (the true first-run signal that covers bun,
 * desktop, and npm installs alike; the wrapper postinstall ping misses bun
 * and desktop entirely).
 */
function getOrCreateInstallId(db: DbAccessor): { readonly id: string; readonly created: boolean } {
	try {
		const existing = db.withReadDb((r) => {
			const row = r.prepare("SELECT id FROM telemetry_install ORDER BY created_at ASC LIMIT 1").get() as
				| { readonly id: string }
				| null
				| undefined;
			return row?.id ?? null;
		});
		if (existing != null) return { id: existing, created: false };

		const id = crypto.randomUUID();
		db.withWriteTx((w) => {
			w.prepare("INSERT OR IGNORE INTO telemetry_install (id, created_at) VALUES (?, ?)").run(
				id,
				new Date().toISOString(),
			);
		});
		return { id, created: true };
	} catch {
		return { id: crypto.randomUUID(), created: false };
	}
}

// ---------------------------------------------------------------------------
// Crash diagnostics
// ---------------------------------------------------------------------------
// error.occurred reports are sanitized at the boundary: the message is
// truncated and stripped of user paths, the stack keeps only the top frames
// with home directories removed, and no memory content is ever captured.
// Enough to reproduce and fix a crash remotely, nothing to leak.

const MAX_CRASH_MESSAGE_CHARS = 400;
const MAX_CRASH_STACK_FRAMES = 8;

const HOME_PATH_PATTERNS = [/\/home\/[^\/\s]+/g, /\/Users\/[^\/\s]+/g];

function stripUserPaths(text: string): string {
	let out = text;
	for (const pattern of HOME_PATH_PATTERNS) {
		out = out.replace(pattern, "~");
	}
	return out;
}

function sanitizeCrashText(value: string): string {
	return stripUserPaths(value.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, MAX_CRASH_MESSAGE_CHARS);
}

function crashStackFrames(stack: string | undefined): string[] | undefined {
	if (!stack) return undefined;
	return stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => stripUserPaths(line))
		.slice(0, MAX_CRASH_STACK_FRAMES);
}

/**
 * Build the sanitized error.occurred properties for a process-level crash.
 * Non-Error reasons (unhandledRejection with a primitive) degrade to a
 * truncated string.
 */
export function sanitizeCrashError(error: unknown, uptimeMs: number): TelemetryProperties {
	const uptime = Math.round(uptimeMs);
	if (error instanceof Error) {
		const stack = crashStackFrames(error.stack);
		return {
			type: error.name || "Error",
			message: sanitizeCrashText(error.message || String(error)),
			...(stack ? { stack: stack.join("\n") } : {}),
			uptimeMs: uptime,
		};
	}
	return {
		type: "UnhandledRejection",
		message: sanitizeCrashText(String(error)),
		uptimeMs: uptime,
	};
}

// ---------------------------------------------------------------------------
// PostHog batch sender
// ---------------------------------------------------------------------------

interface PostHogBatchEvent {
	readonly event: string;
	readonly distinct_id: string;
	readonly timestamp: string;
	readonly properties: Record<string, string | number | boolean | null>;
}

const MAX_BUFFER_SIZE = 200;
const MAX_BUFFER_EVENTS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MULTIPLIER = 5;
const PRUNE_EVERY_N_FLUSHES = 10;

/**
 * Interval used after `failures` consecutive PostHog failures. Pure so the
 * backoff behavior is testable without driving timers.
 */
export function nextFlushIntervalMs(baseIntervalMs: number, consecutiveFailures: number): number {
	return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? baseIntervalMs * BACKOFF_MULTIPLIER : baseIntervalMs;
}

async function sendToPostHog(
	host: string,
	apiKey: string,
	distinctId: string,
	events: readonly TelemetryEvent[],
	daemonVersion: string,
): Promise<boolean> {
	const batch: readonly PostHogBatchEvent[] = events.map((e) => ({
		event: e.event,
		distinct_id: distinctId,
		timestamp: e.timestamp,
		properties: {
			...e.properties,
			$lib: "signet-daemon",
			$lib_version: daemonVersion,
		},
	}));

	try {
		const res = await fetch(`${host}/batch/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: apiKey, batch }),
			signal: AbortSignal.timeout(10000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTelemetryCollector(
	db: DbAccessor,
	config: PipelineTelemetryConfig,
	daemonVersion: string,
	opts: { readonly telemetryLogPath?: string | null } = {},
): TelemetryCollector {
	const buffer: TelemetryEvent[] = [];
	const logPath = opts.telemetryLogPath ?? null;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let consecutiveFailures = 0;
	let flushCount = 0;
	let effectiveIntervalMs = config.flushIntervalMs;
	const { id: installId, created: installActivated } = getOrCreateInstallId(db);

	const posthogConfigured = config.posthogHost.length > 0 && config.posthogApiKey.length > 0;

	function writeToDb(events: readonly TelemetryEvent[]): void {
		if (events.length === 0) return;
		try {
			db.withWriteTx((w) => {
				const stmt = w.prepare(
					`INSERT OR IGNORE INTO telemetry_events
					 (id, event, timestamp, properties, sent_to_posthog, created_at)
					 VALUES (?, ?, ?, ?, 0, ?)`,
				);
				const now = new Date().toISOString();
				for (const e of events) {
					stmt.run(e.id, e.event, e.timestamp, JSON.stringify(e.properties), now);
				}
			});
		} catch (err) {
			logger.warn("telemetry", "Failed to write events to db", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	function markSent(ids: readonly string[]): void {
		if (ids.length === 0) return;
		try {
			db.withWriteTx((w) => {
				const stmt = w.prepare("UPDATE telemetry_events SET sent_to_posthog = 1 WHERE id = ?");
				for (const id of ids) {
					stmt.run(id);
				}
			});
		} catch {
			// best effort
		}
	}

	function loadUnsent(limit: number): readonly TelemetryEvent[] {
		try {
			return db.withReadDb((r) => {
				const rows = r
					.prepare(
						`SELECT id, event, timestamp, properties
						 FROM telemetry_events
						 WHERE sent_to_posthog = 0
						 ORDER BY timestamp ASC
						 LIMIT ?`,
					)
					.all(limit) as unknown as readonly {
					id: string;
					event: string;
					timestamp: string;
					properties: string;
				}[];

				return rows.map((row) => ({
					id: row.id,
					event: row.event as TelemetryEventType,
					timestamp: row.timestamp,
					properties: JSON.parse(row.properties) as TelemetryProperties,
				}));
			});
		} catch {
			return [];
		}
	}

	function pruneOldEvents(): void {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - config.retentionDays);
		try {
			db.withWriteTx((w) => {
				w.prepare("DELETE FROM telemetry_events WHERE timestamp < ?").run(cutoff.toISOString());
			});
		} catch {
			// best effort
		}
	}

	async function doFlush(): Promise<void> {
		flushCount++;
		// Drain buffer to SQLite
		const pending = buffer.splice(0, buffer.length);
		writeToDb(pending);

		// Send to PostHog if configured
		if (posthogConfigured) {
			const unsent = loadUnsent(config.flushBatchSize);
			if (unsent.length > 0) {
				const ok = await sendToPostHog(config.posthogHost, config.posthogApiKey, installId, unsent, daemonVersion);
				if (ok) {
					markSent(unsent.map((e) => e.id));
					consecutiveFailures = 0;
					effectiveIntervalMs = config.flushIntervalMs;
				} else {
					consecutiveFailures++;
					effectiveIntervalMs = nextFlushIntervalMs(config.flushIntervalMs, consecutiveFailures);
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						logger.warn("telemetry", "PostHog unreachable, backing off", {
							intervalMs: effectiveIntervalMs,
						});
					}
				}
			}
		}

		// Occasional pruning (every 10th flush, deterministic for tests)
		if (flushCount % PRUNE_EVERY_N_FLUSHES === 0) {
			pruneOldEvents();
		}
	}

	const collector: TelemetryCollector = {
		enabled: true,
		anonymizeAgentId(agentId: string): string {
			return createHash("sha256").update(`${agentId}:${installId}`).digest("hex").slice(0, 16);
		},

		record(event, properties): void {
			if (buffer.length >= MAX_BUFFER_EVENTS) {
				const dropCount = buffer.length - MAX_BUFFER_EVENTS + 1;
				buffer.splice(0, dropCount);
				logger.warn("telemetry", "Buffer exceeded max capacity, dropping oldest events", {
					dropped: dropCount,
					maxBufferEvents: MAX_BUFFER_EVENTS,
				});
			}

			buffer.push({
				id: crypto.randomUUID(),
				event,
				timestamp: new Date().toISOString(),
				properties,
			});

			// Open telemetry log (issue #1026 Phase 2): mirror every event to
			// the inspectable JSONL file so users can audit exactly what was
			// sent. Best-effort — a full disk or unwritable path must never
			// break recording.
			if (logPath) {
				const last = buffer[buffer.length - 1];
				if (last) {
					appendToTelemetryLog(logPath, JSON.stringify(last));
				}
			}

			if (buffer.length >= MAX_BUFFER_SIZE) {
				doFlush().catch(() => {});
			}
		},

		async flush(): Promise<void> {
			await doFlush();
		},

		start(): void {
			if (running) return;
			running = true;

			function scheduleFlush(): void {
				if (!running) return;
				flushTimer = setTimeout(() => {
					flushTimer = null;
					doFlush()
						.catch(() => {})
						.finally(() => scheduleFlush());
				}, effectiveIntervalMs);
			}

			scheduleFlush();
			logger.info("telemetry", "Telemetry collector started", {
				posthog: posthogConfigured,
				flushIntervalMs: config.flushIntervalMs,
			});
		},

		async stop(): Promise<void> {
			running = false;
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			await doFlush();
			logger.info("telemetry", "Telemetry collector stopped");
		},

		query(opts): readonly TelemetryEvent[] {
			try {
				return db.withReadDb((r) => {
					const conditions: string[] = [];
					const params: unknown[] = [];

					if (opts?.event) {
						conditions.push("event = ?");
						params.push(opts.event);
					}
					if (opts?.since) {
						conditions.push("timestamp >= ?");
						params.push(opts.since);
					}
					if (opts?.until) {
						conditions.push("timestamp <= ?");
						params.push(opts.until);
					}

					const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
					const limit = opts?.limit ?? 100;

					const rows = r
						.prepare(
							`SELECT id, event, timestamp, properties
							 FROM telemetry_events
							 ${where}
							 ORDER BY timestamp DESC
							 LIMIT ?`,
						)
						.all(...params, limit) as unknown as readonly {
						id: string;
						event: string;
						timestamp: string;
						properties: string;
					}[];

					return rows.map((row) => ({
						id: row.id,
						event: row.event as TelemetryEventType,
						timestamp: row.timestamp,
						properties: JSON.parse(row.properties) as TelemetryProperties,
					}));
				});
			} catch {
				return [];
			}
		},
	};

	// First run of a new install: emit install.activated so daemon-running
	// installs are countable regardless of how they were installed (the npm
	// postinstall ping never fires for bun global or desktop installs).
	if (installActivated) {
		collector.record("install.activated", {
			version: daemonVersion,
			platform: process.platform,
		});
	}

	return collector;
}
