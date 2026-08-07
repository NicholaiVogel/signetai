/**
 * Migration 109: Telemetry Install Identity
 *
 * Holds the anonymous per-install identifier used as the PostHog
 * distinct_id. A single row persists across daemon restarts so every
 * event from one install maps to one PostHog user. Before this table,
 * the collector sent a constant "signet-anonymous" id, which collapsed
 * all installs into a single PostHog user and made install and usage
 * analytics impossible.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_install (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		);
	`);
}
