import { describe, expect, test } from "bun:test";
import type { DbOwnerClient } from "./db-owner-client";
import {
	MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS,
	MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS,
	MIGRATION_VERIFY_PARKED_STATUS,
	MIGRATION_VERIFY_RETRY_INTERVAL_MS,
	migrationVerifyCheckpointKey,
	runMigrationIntegrityVerifyGate,
	type MigrationVerifyCheckpointStore,
	type MigrationVerifyResult,
} from "./migration-integrity-verify";
import type { MigrationVerifyCheckpoint } from "./incremental-database-integrity";

const owner = {} as DbOwnerClient;

function attempt(phase: MigrationVerifyResult["phase"]): MigrationVerifyResult {
	return { phase, messages: phase === "failed" ? ["corrupt"] : [], elapsedMs: 12, attemptDeadlineMs: 300_000 };
}

function fakeStore(
	initialAttemptCount = 0,
	events: string[] = [],
): {
	store: MigrationVerifyCheckpointStore;
	state: { checkpoint: MigrationVerifyCheckpoint; terminal: string | null };
} {
	const state = {
		checkpoint: { attemptCount: initialAttemptCount, status: "running" } as MigrationVerifyCheckpoint,
		terminal: null as string | null,
	};
	return {
		state,
		store: {
			read: async () => state.checkpoint,
			incrementIncompleteAttempt: async () => {
				events.push("attempt-persisted");
				state.checkpoint = { ...state.checkpoint, attemptCount: state.checkpoint.attemptCount + 1 };
				return state.checkpoint.attemptCount;
			},
			markTerminal: async (status) => {
				state.terminal = status;
				state.checkpoint = { ...state.checkpoint, status };
			},
		},
	};
}

describe("migration integrity verify gate", () => {
	test("scopes checkpoint state to the backup generation", () => {
		expect(migrationVerifyCheckpointKey("/tmp/memories.db.bak-v151-1234")).toBe(
			"database.migration-verify:memories.db.bak-v151-1234",
		);
		expect(migrationVerifyCheckpointKey("/tmp/memories.db.bak-v152-5678")).not.toBe(
			migrationVerifyCheckpointKey("/tmp/memories.db.bak-v151-1234"),
		);
	});

	test("uses one 300-second attempt and a fixed 30-minute continuation interval", () => {
		expect(MIGRATION_VERIFY_ATTEMPT_DEADLINE_MS).toBe(300_000);
		expect(MIGRATION_VERIFY_RETRY_INTERVAL_MS).toBe(30 * 60_000);
	});

	test("prunes the rollback backup only after a pass result", async () => {
		const { store, state } = fakeStore();
		let pruned = false;
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("pass"),
			pruneBackup: () => {
				pruned = true;
			},
		});

		expect(result.phase).toBe("pass");
		expect(pruned).toBe(true);
		expect(state.terminal).toBe("complete");
	});

	test("retains the rollback backup and schedules only one fixed-delay retry after incomplete", async () => {
		const events: string[] = [];
		const { store, state } = fakeStore(0, events);
		let pruned = false;
		let scheduledDelay = 0;
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => {
				expect(events).toEqual(["attempt-persisted"]);
				events.push("integrity-check");
				return attempt("incomplete");
			},
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: (_callback, delayMs) => {
				scheduledDelay = delayMs;
			},
		});

		expect(result.phase).toBe("incomplete");
		expect(result.scheduled).toBe(true);
		expect(pruned).toBe(false);
		expect(scheduledDelay).toBe(MIGRATION_VERIFY_RETRY_INTERVAL_MS);
		expect(state.checkpoint.attemptCount).toBe(1);
	});

	test("retains the rollback backup and stops immediately after a failed result", async () => {
		const { store, state } = fakeStore();
		let pruned = false;
		let scheduled = false;
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("failed"),
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: () => {
				scheduled = true;
			},
		});

		expect(result.phase).toBe("failed");
		expect(pruned).toBe(false);
		expect(scheduled).toBe(false);
		expect(state.terminal).toBe("failed:integrity-unverified");
	});

	test("parks after eight incomplete attempts with degraded:integrity-unverified", async () => {
		const { store, state } = fakeStore(MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS - 1);
		let pruned = false;
		let scheduled = false;
		const result = await runMigrationIntegrityVerifyGate({
			owner,
			backupPath: "/tmp/memories.db.bak-v151-1234",
			checkpointStore: store,
			runAttempt: async () => attempt("incomplete"),
			pruneBackup: () => {
				pruned = true;
			},
			scheduleNextAttempt: () => {
				scheduled = true;
			},
		});

		expect(result.phase).toBe("parked");
		expect(result.attemptCount).toBe(MIGRATION_VERIFY_MAX_INCOMPLETE_ATTEMPTS);
		expect(state.terminal).toBe(MIGRATION_VERIFY_PARKED_STATUS);
		expect(pruned).toBe(false);
		expect(scheduled).toBe(false);
	});
});
