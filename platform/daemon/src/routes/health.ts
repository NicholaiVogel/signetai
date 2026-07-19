import type { Hono } from "hono";
import { getDbAccessor } from "../db-accessor";
import { getAllFeatureFlags } from "../feature-flags";
import { getPipelineWorkerStatus } from "../pipeline";
import { getResourceSnapshot } from "../resource-monitor";
import { getUpdateState } from "../update-system";
import { AGENTS_DIR, CURRENT_VERSION, PORT, getCachedDiagnosticsReport, shuttingDown } from "./state.js";

export function mountHealthRoutes(app: Hono): void {
	app.get("/health", (c) => {
		const us = getUpdateState();
		let dbOk = false;
		try {
			getDbAccessor().withReadDb((db) => {
				db.prepare("SELECT 1").get();
				dbOk = true;
			});
		} catch {}
		const workers = getPipelineWorkerStatus();
		const extraction = workers.extraction;
		const stalled =
			extraction.running &&
			extraction.stats !== undefined &&
			extraction.stats.pending > 0 &&
			Date.now() - extraction.stats.lastProgressAt > 60_000;

		// Issue #901 — surface queue summary counts so existing scrapers
		// see the new signal without changing the /health shape too much.
		let queueSummaryDead = 0;
		let queueMemoryDead = 0;
		let queueExtractionDead = 0;
		let queueSummaryOldestDeadSec = 0;
		try {
			const report = getCachedDiagnosticsReport();
			queueSummaryDead = report.queue.summary.dead;
			queueMemoryDead = report.queue.memory.dead;
			queueExtractionDead = report.queue.extraction.dead;
			queueSummaryOldestDeadSec = report.queue.summary.oldestDeadAgeSec;
		} catch {
			// diagnostics cache may not be ready yet
		}

		return c.json({
			status: shuttingDown ? "shutting_down" : "healthy",
			uptime: process.uptime(),
			pid: process.pid,
			version: CURRENT_VERSION,
			port: PORT,
			agentsDir: AGENTS_DIR,
			db: dbOk,
			shuttingDown,
			updateAvailable: us.lastCheck?.updateAvailable ?? false,
			pendingRestart: us.pendingRestartVersion !== null,
			pipeline: {
				extractionRunning: extraction.running,
				extractionStalled: stalled,
				extractionPending: extraction.stats?.pending ?? 0,
				extractionBackoffMs: extraction.stats?.backoffMs ?? 0,
			},
			queue: {
				memoryDead: queueMemoryDead,
				summaryDead: queueSummaryDead,
				extractionDead: queueExtractionDead,
				summaryOldestDeadSec: queueSummaryOldestDeadSec,
			},
			resources: getResourceSnapshot(),
		});
	});

	// Liveness probe — returns 200 as long as the process is alive. Use
	// for Kubernetes-style liveness (restart on failure).
	app.get("/health/live", (c) => {
		return c.json({
			status: "alive",
			uptime: process.uptime(),
			pid: process.pid,
			shuttingDown,
		});
	});

	// Readiness probe — returns 200 only when the daemon is willing to
	// serve traffic. Pulls out of rotation when DB is down, the daemon is
	// shutting down, or summary/exraction dead-job backlog exceeds the
	// configured thresholds (issue #901).
	app.get("/health/ready", (c) => {
		const reasons: string[] = [];
		if (shuttingDown) reasons.push("shutting_down");

		let dbOk = false;
		try {
			getDbAccessor().withReadDb((db) => {
				db.prepare("SELECT 1").get();
				dbOk = true;
			});
		} catch {
			reasons.push("db_unavailable");
		}

		let summaryDead = 0;
		let summaryOldestPendingSec = 0;
		let extractionDead = 0;
		try {
			const report = getCachedDiagnosticsReport();
			summaryDead = report.queue.summary.dead;
			summaryOldestPendingSec = report.queue.summary.oldestAgeSec;
			extractionDead = report.queue.extraction.dead;
		} catch {
			// diagnostics may not be ready; do not block readiness on it
		}

		if (summaryDead >= 500) reasons.push(`summary_dead_exceeded:${summaryDead}`);
		if (extractionDead >= 500) reasons.push(`extraction_dead_exceeded:${extractionDead}`);
		if (summaryOldestPendingSec >= 1800)
			reasons.push(`summary_oldest_pending_exceeded:${Math.round(summaryOldestPendingSec)}s`);

		const ready = reasons.length === 0;
		const status = ready ? 200 : 503;
		return c.json(
			{
				status: ready ? "ready" : "not_ready",
				ready,
				db: dbOk,
				queue: {
					summaryDead,
					extractionDead,
					summaryOldestPendingSec,
				},
				reasons,
			},
			status,
		);
	});

	app.get("/api/features", (c) => {
		return c.json(getAllFeatureFlags());
	});
}
