/**
 * Regression test: dreaming pass token usage must reach the telemetry
 * pipeline (dreaming.pass) so dreaming economics show up in PostHog — the
 * local dreaming_passes table alone was invisible to analytics.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { type TelemetryCollector, createTelemetryCollector, setActiveTelemetry } from "../telemetry";
import { cleanupTestTempDir, createTestTempDir } from "../test-temp-dir";
import { recordDreamingPassTelemetry } from "./dreaming";

let dir = "";

const TELEMETRY_CONFIG = {
	posthogHost: "",
	posthogApiKey: "",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

describe("dreaming telemetry", () => {
	beforeAll(() => {
		dir = createTestTempDir("signet-dream-telemetry-");
		closeDbAccessor();
		rmSync(join(dir, "memory"), { recursive: true, force: true });
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterAll(() => {
		setActiveTelemetry(undefined);
		closeDbAccessor();
		cleanupTestTempDir(dir);
	});

	it("emits dreaming.pass with provider-reported usage at pass completion", async () => {
		const collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test");
		setActiveTelemetry(collector);

		recordDreamingPassTelemetry({
			mode: "agentic",
			usage: {
				inputTokens: 384561,
				outputTokens: 18227,
				cacheReadTokens: 100000,
				cacheCreationTokens: 5000,
				totalCost: 0.14574042,
			},
		});
		recordDreamingPassTelemetry({ mode: "hygiene", usage: null });
		await collector.flush();

		const passes = collector.query().filter((e) => e.event === "dreaming.pass");
		expect(passes).toHaveLength(2);
		const full = passes.find((e) => e.properties.mode === "agentic");
		expect(full?.properties.tokensInput).toBe(384561);
		expect(full?.properties.tokensOutput).toBe(18227);
		expect(full?.properties.tokensCacheRead).toBe(100000);
		expect(full?.properties.tokensCacheWrite).toBe(5000);
		expect(full?.properties.cost).toBe(0.14574042);
		const bare = passes.find((e) => e.properties.mode === "hygiene");
		expect(bare?.properties.tokensInput).toBeNull();
		expect(bare?.properties.cost).toBeNull();
	});
});
