/**
 * Migration 096: retire the unscoped legacy core ingest ledger.
 *
 * `ingestPath` was an uncalled direct semantic writer that bypassed immutable
 * artifacts and the daemon's scoped source pipeline. Existing `memories`
 * rows remain available to retrieval; without immutable source artifacts,
 * they are deliberately not promoted into Dreaming evidence here.
 */
import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec("DROP TABLE IF EXISTS ingestion_jobs");
}
