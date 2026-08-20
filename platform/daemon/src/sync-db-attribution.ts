/**
 * Always-on attribution for transitional synchronous SQLite calls.
 *
 * The event-loop monitor runs on the same isolate as SQLite, so a monitor tick
 * cannot observe a synchronous call while it is executing. We therefore retain
 * a bounded interval history and match the observed stall window against calls
 * that overlapped it. The timestamps and site id are deliberately local-only;
 * no SQL, arguments, or user data are retained.
 */

export type SyncDbCallKind = "withReadDb" | "withWriteTx";

export interface SyncDbCallToken {
	readonly sequence: number;
	readonly siteId: string;
	readonly kind: SyncDbCallKind;
	readonly startedAtMs: number;
}

export interface SyncDbAttributionMetrics {
	readonly calls: number;
	readonly slowCalls: number;
	readonly totalDurationMs: number;
	readonly maxDurationMs: number;
	readonly unattributedCalls: number;
	readonly unattributedDurationMs: number;
	readonly unattributedSlowDurationMs: number;
	readonly sites: readonly SyncDbCallSiteMetrics[];
}

export interface SyncDbCallSiteMetrics {
	readonly siteId: string;
	readonly calls: number;
	readonly slowCalls: number;
	readonly totalDurationMs: number;
	readonly maxDurationMs: number;
}

interface SyncDbCallRecord {
	readonly sequence: number;
	readonly siteId: string;
	readonly kind: SyncDbCallKind;
	readonly startedAtMs: number;
	endedAtMs: number | null;
	durationMs: number | null;
}

const MAX_HISTORY = 256;
const SLOW_CALL_THRESHOLD_MS = 50;
const history: SyncDbCallRecord[] = [];
const inFlight = new Map<number, SyncDbCallRecord>();
const siteMetrics = new Map<
	string,
	{ calls: number; slowCalls: number; totalDurationMs: number; maxDurationMs: number }
>();
let nextSequence = 1;
let calls = 0;
let slowCalls = 0;
let totalDurationMs = 0;
let maxDurationMs = 0;
let unattributedCalls = 0;
let unattributedDurationMs = 0;
let unattributedSlowDurationMs = 0;

function normalizeFileName(value: string): string {
	if (value.startsWith("file://")) {
		try {
			return decodeURIComponent(new URL(value).pathname);
		} catch {
			return value.slice("file://".length);
		}
	}
	return value;
}

function parseFrame(
	line: string,
): { readonly file: string; readonly line: number; readonly functionName: string } | null {
	const match = /(?:\(|\s)((?:file:\/\/)?[^()\s]+):(\d+):\d+\)?$/.exec(line);
	if (!match) return null;
	const lineNumber = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isInteger(lineNumber) || lineNumber <= 0) return null;
	const functionName = line
		.replace(/\s+\([^()]+\)$/, "")
		.replace(/^\s*at\s+/, "")
		.trim();
	return { file: normalizeFileName(match[1] ?? ""), line: lineNumber, functionName };
}

function callerSite(): string {
	const stack = new Error().stack?.split("\n").slice(1) ?? [];
	for (const frame of stack) {
		const parsed = parseFrame(frame);
		if (!parsed) continue;
		if (
			parsed.functionName.endsWith("callerSite") ||
			parsed.functionName.endsWith("beginSyncDbCall") ||
			parsed.functionName.endsWith("endSyncDbCall") ||
			parsed.functionName.endsWith("withReadDb") ||
			parsed.functionName.endsWith("withWriteTx") ||
			parsed.file.endsWith("/sync-db-attribution.ts") ||
			parsed.file.endsWith("/db-accessor.ts") ||
			parsed.file.startsWith("node:") ||
			parsed.file.startsWith("bun:")
		) {
			continue;
		}
		return `${parsed.file}:${parsed.line}`;
	}
	return "unknown:0";
}

export function beginSyncDbCall(kind: SyncDbCallKind, startedAtMs = Date.now()): SyncDbCallToken {
	const siteId = `${kind}@${callerSite()}`;
	const record: SyncDbCallRecord = {
		sequence: nextSequence++,
		siteId,
		kind,
		startedAtMs,
		endedAtMs: null,
		durationMs: null,
	};
	inFlight.set(record.sequence, record);
	return {
		sequence: record.sequence,
		siteId,
		kind,
		startedAtMs,
	};
}

export function endSyncDbCall(token: SyncDbCallToken, endedAtMs = Date.now()): void {
	const record = inFlight.get(token.sequence);
	if (!record) return;
	inFlight.delete(token.sequence);
	record.endedAtMs = Math.max(token.startedAtMs, endedAtMs);
	record.durationMs = record.endedAtMs - token.startedAtMs;
	calls++;
	totalDurationMs += record.durationMs;
	maxDurationMs = Math.max(maxDurationMs, record.durationMs);
	if (record.durationMs >= SLOW_CALL_THRESHOLD_MS) slowCalls++;
	const site = siteMetrics.get(record.siteId) ?? { calls: 0, slowCalls: 0, totalDurationMs: 0, maxDurationMs: 0 };
	site.calls++;
	site.totalDurationMs += record.durationMs;
	site.maxDurationMs = Math.max(site.maxDurationMs, record.durationMs);
	if (record.durationMs >= SLOW_CALL_THRESHOLD_MS) site.slowCalls++;
	siteMetrics.set(record.siteId, site);
	if (record.siteId.endsWith("@unknown:0")) {
		unattributedCalls++;
		unattributedDurationMs += record.durationMs;
		if (record.durationMs >= SLOW_CALL_THRESHOLD_MS) unattributedSlowDurationMs += record.durationMs;
	}
	history.push(record);
	if (history.length > MAX_HISTORY) history.shift();
}

/** Return site ids whose synchronous interval overlapped the observed stall. */
export function getSyncDbCallSitesForWindow(startMs: number, endMs: number): readonly string[] {
	const sites = new Set<string>();
	for (const record of [...history, ...inFlight.values()]) {
		const recordEnd = record.endedAtMs ?? endMs;
		if (record.startedAtMs <= endMs && recordEnd >= startMs) sites.add(record.siteId);
	}
	return [...sites].sort();
}

export function getSyncDbAttributionMetrics(): SyncDbAttributionMetrics {
	return {
		calls,
		slowCalls,
		totalDurationMs,
		maxDurationMs,
		unattributedCalls,
		unattributedDurationMs,
		unattributedSlowDurationMs,
		sites: [...siteMetrics.entries()]
			.map(([siteId, site]) => ({ siteId, ...site }))
			.sort((a, b) => b.totalDurationMs - a.totalDurationMs),
	};
}

export function resetSyncDbAttribution(): void {
	history.length = 0;
	inFlight.clear();
	siteMetrics.clear();
	nextSequence = 1;
	calls = 0;
	slowCalls = 0;
	totalDurationMs = 0;
	maxDurationMs = 0;
	unattributedCalls = 0;
	unattributedDurationMs = 0;
	unattributedSlowDurationMs = 0;
}
