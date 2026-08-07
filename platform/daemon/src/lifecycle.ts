import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Daemon lifecycle record.
 *
 * The daemon writes its state to `.daemon/lifecycle.json` at startup and on
 * every catchable exit path (signal handlers, fatal errors). The record is the
 * one durable artifact that survives the process itself, so a later
 * `signet status` / `signet doctor` can tell a clean shutdown apart from an
 * external kill or a hard crash (issue #1148): a process that died without
 * writing `clean` (SIGKILL, OOM, segfault) leaves the record stuck at
 * `starting`/`running`, and the CLI reports an unrecorded death instead of a
 * silent disappearance.
 *
 * The record is written synchronously and atomically (temp file + rename) so a
 * concurrent reader never observes a partial write.
 */

export type DaemonLifecycleState = "starting" | "running" | "clean" | "error";

export interface DaemonLifecycle {
	readonly state: DaemonLifecycleState;
	readonly pid: number;
	readonly version: string;
	readonly startedAt: string;
	/** systemd transient unit name (Linux service-manager launch), when known. */
	readonly systemdUnit?: string;
	readonly exitedAt?: string;
	readonly exitCode?: number;
	/** Exit-path label: "signal:SIGTERM" | "signal:SIGINT" | "error:uncaughtException" | ... */
	readonly reason?: string;
	readonly error?: string;
}

export function lifecyclePath(agentsDir: string): string {
	return join(agentsDir, ".daemon", "lifecycle.json");
}

/** Tolerant read: a missing or corrupt record returns null, never throws. */
export function readDaemonLifecycle(agentsDir: string): DaemonLifecycle | null {
	try {
		const raw = readFileSync(lifecyclePath(agentsDir), "utf-8");
		const parsed = JSON.parse(raw) as Partial<DaemonLifecycle>;
		if (typeof parsed.state !== "string" || typeof parsed.pid !== "number") {
			return null;
		}
		return parsed as DaemonLifecycle;
	} catch {
		return null;
	}
}

/** Best-effort atomic write; recording must never take the daemon down. */
export function writeDaemonLifecycle(agentsDir: string, record: DaemonLifecycle): void {
	const path = lifecyclePath(agentsDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = `${path}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(record, null, 2));
		renameSync(tmpPath, path);
	} catch {
		// Best effort.
	}
}
