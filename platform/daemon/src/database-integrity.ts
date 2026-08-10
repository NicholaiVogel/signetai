/**
 * Startup integrity checks for SQLite's derived database surfaces.
 *
 * `PRAGMA quick_check` deliberately does not validate every index/table
 * relationship. The telemetry table is append-only and its indexes are
 * disposable, so it gets a targeted full check and a transactional REINDEX
 * when SQLite reports an index mismatch.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";

const TELEMETRY_INDEXES = [
	"idx_telemetry_events_event",
	"idx_telemetry_events_timestamp",
	"idx_telemetry_events_unsent",
] as const;

export type DatabaseIntegrityState = "unknown" | "healthy" | "repaired" | "corrupt" | "unavailable";

export interface IntegrityCheckStatus {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

export interface DatabaseIntegrityStatus {
	readonly checkedAt: string;
	readonly state: DatabaseIntegrityState;
	readonly quickCheck: IntegrityCheckStatus;
	readonly telemetryCheck: IntegrityCheckStatus;
	readonly rebuiltIndexes: readonly string[];
}

const UNKNOWN_CHECK: IntegrityCheckStatus = { ok: false, messages: ["not checked"] };

let latestStatus: DatabaseIntegrityStatus = {
	checkedAt: "",
	state: "unknown",
	quickCheck: UNKNOWN_CHECK,
	telemetryCheck: UNKNOWN_CHECK,
	rebuiltIndexes: [],
};

function check(db: ReadDb, pragma: "quick_check" | "integrity_check", table?: string): IntegrityCheckStatus {
	const sql = table === undefined ? `PRAGMA ${pragma}` : `PRAGMA ${pragma}(${table})`;
	const key = pragma === "quick_check" ? "quick_check" : "integrity_check";
	const rows = db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>;
	const messages = rows.map((row) => String(row[key] ?? ""));
	if (messages.length === 1 && messages[0] === "ok") return { ok: true, messages: [] };
	return { ok: false, messages };
}

function escapedIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function statusWith(
	state: DatabaseIntegrityState,
	quickCheck: IntegrityCheckStatus,
	telemetryCheck: IntegrityCheckStatus,
	rebuiltIndexes: readonly string[],
): DatabaseIntegrityStatus {
	return {
		checkedAt: new Date().toISOString(),
		state,
		quickCheck,
		telemetryCheck,
		rebuiltIndexes,
	};
}

/** Return the last startup integrity result without touching SQLite. */
export function getDatabaseIntegrityStatus(): DatabaseIntegrityStatus {
	return latestStatus;
}

export type TelemetryIndexRepairAudit = (
	db: WriteDb,
	indexes: readonly string[],
	detectionMessages: readonly string[],
) => void;

/**
 * Check the database before background workers start and repair only the
 * disposable telemetry indexes when the targeted check identifies damage.
 * The optional audit runs inside the same write transaction as REINDEX.
 */
export function repairTelemetryIndexes(
	accessor: DbAccessor,
	audit?: TelemetryIndexRepairAudit,
): DatabaseIntegrityStatus {
	let quickCheck: IntegrityCheckStatus;
	let telemetryCheck: IntegrityCheckStatus;
	try {
		const checks = accessor.withReadDb((db) => ({
			quick: check(db, "quick_check"),
			telemetry: check(db, "integrity_check", "telemetry_events"),
		}));
		quickCheck = checks.quick;
		telemetryCheck = checks.telemetry;
	} catch (error) {
		latestStatus = statusWith(
			"unavailable",
			{ ok: false, messages: [error instanceof Error ? error.message : String(error)] },
			UNKNOWN_CHECK,
			[],
		);
		return latestStatus;
	}

	if (quickCheck.ok && telemetryCheck.ok) {
		latestStatus = statusWith("healthy", quickCheck, telemetryCheck, []);
		return latestStatus;
	}

	// quick_check covers the whole database. A failed global check is not
	// safely repairable by rebuilding a telemetry index, even if that index is
	// also mentioned in the targeted failure.
	if (!quickCheck.ok) {
		latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
		return latestStatus;
	}

	if (!telemetryCheck.ok) {
		try {
			accessor.withWriteTx((db) => {
				for (const index of TELEMETRY_INDEXES) db.exec(`REINDEX ${escapedIdentifier(index)}`);
				audit?.(db, TELEMETRY_INDEXES, telemetryCheck.messages);
			});
			const verifiedTelemetry = accessor.withReadDb((db) => check(db, "integrity_check", "telemetry_events"));
			if (verifiedTelemetry.ok) {
				latestStatus = statusWith("repaired", quickCheck, verifiedTelemetry, [...TELEMETRY_INDEXES]);
				return latestStatus;
			}
			telemetryCheck = verifiedTelemetry;
		} catch (error) {
			telemetryCheck = {
				ok: false,
				messages: [...telemetryCheck.messages, error instanceof Error ? error.message : String(error)],
			};
		}
	}

	latestStatus = statusWith("corrupt", quickCheck, telemetryCheck, []);
	return latestStatus;
}
