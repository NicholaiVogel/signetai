/**
 * Regression coverage for production worker wiring.
 *
 * These calls live in daemon.ts rather than an injectable factory, so this
 * probe checks the exact startup source that the running daemon executes.
 */
import { describe, expect, it } from "bun:test";

const daemonSourceUrl = new URL("./daemon.ts", import.meta.url);

describe("daemon production DB owner wiring", () => {
	it("passes the registered maintenance owner to pipeline and Dreaming startup", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain(
			"dbOwnerMaintenanceHandle = createDbOwnerMaintenance({ dbPath: MEMORY_DB, owner: dbOwnerClient });",
		);
		expect(source).toContain("registerDbOwnerMaintenance(dbOwnerMaintenanceHandle);");
		expect(source).toContain("deferredRuntimeScheduler.scheduleMaintenance(async (): Promise<void> => {");
		expect(source).toContain("completeFtsStartupRecovery({");
		expect(source).toContain("			telemetry,\n			dbOwnerMaintenanceHandle ?? undefined,\n		);");
		expect(source).toContain("ownerMaintenance: dbOwnerMaintenanceHandle ?? undefined,");
	});

	it("keeps post-ready integrity maintenance incremental and checkpointed", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("runIncrementalDatabaseIntegrityCheck");
		expect(source).toContain('checkpointKey: "database.quick-check"');
		expect(source).toContain("INCREMENTAL_INTEGRITY_TABLES_PER_RUN");
		expect(source).toContain("let globalVerifyInFlight = false;");
		expect(source).toContain("if (globalVerifyInFlight) return;");
		expect(source).toContain("if (integritySlicePending) scheduleIntegritySlice(0);");
		expect(source).toContain("const publishMigrationVerifyStatus =");
		expect(source).toContain("scheduledVerifyRuntimeGateReleased");
		expect(source).toContain("deferredRuntimeGate.completeIntegrity();");
		expect(source).toContain("if (!migrationIntegrityGateActive && !integrityGateCompleted) {");
		expect(source).not.toContain(
			"if (!migrationIntegrityGateActive) {\n				integrityGateCompleted = true;\n				deferredRuntimeGate.completeIntegrity();\n			}",
		);
		expect(source).toContain('if (result.phase === "incomplete" && result.admitted)');
		expect(source).toContain("scheduleNextAttempt: (callback, delayMs): void => {");
		expect(source).toContain("void workerSettled.then(() => {");
		expect(source).toContain("onWorkerSettled: settleWorker");
		expect(source).not.toContain("runDeferredIntegrityCheck");
	});

	it("retries migration verification after setup rejection with a bounded cap", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("createMigrationVerifySetupRetry");
		expect(source).toContain("onContinuationRejection");
		expect(source).not.toContain("setupRejectionAttempts");
		expect(source).toContain("setupRetry.run();");
	});

	it("keeps a paused startup source partial instead of reporting success", async () => {
		const source = await Bun.file(daemonSourceUrl).text();

		expect(source).toContain("const syncResult = nativeMemoryBridge?.getLastSyncResult?.();");
		expect(source).toContain("pauseSourceIndexJob(sourceId, jobId, {");
		expect(source).toContain("scanned: paused.scanned,");
		expect(source).toContain("indexed: paused.indexed,");
		expect(source).toContain('outcome: syncResult?.status === "paused" && paused ? "partial" : "success",');
		expect(source).toContain('updateFreshness: syncResult?.status === "paused" && paused ? false : undefined,');
	});
});
