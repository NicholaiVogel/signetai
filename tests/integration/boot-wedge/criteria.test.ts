import { describe, expect, test } from "bun:test";
import {
	BOOT_TIMEOUT_MS,
	CPU_CEILING_PERCENT,
	MIN_CPU_SAMPLES,
	LIVE_REQUEST_TIMEOUT_MS,
	evaluateBootWedge,
	type BootWedgeMeasurements,
} from "./criteria";
import { hasLiveProcessTarget, isLivePayload, isLiveResponse, snapshotProcessTargets } from "./run";

function measurements(overrides: Partial<BootWedgeMeasurements> = {}): BootWedgeMeasurements {
	return {
		startupMs: 1_000,
		live: { samples: 20, successes: 20, failures: 0, maxMs: 12 },
		cpu: { samples: MIN_CPU_SAMPLES, maxPercent: 2 },
		...overrides,
	};
}

describe("boot-wedge safety criteria", () => {
	test("passes a live daemon that stays below the CPU ceiling", () => {
		expect(evaluateBootWedge(measurements()).pass).toBe(true);
	});

	test("fails when source-run startup exceeds the bounded boot deadline", () => {
		const result = evaluateBootWedge(measurements({ startupMs: BOOT_TIMEOUT_MS + 1 }));
		expect(result.pass).toBe(false);
		expect(result.checks[0]?.pass).toBe(false);
	});

	test("fails when liveness loses a response", () => {
		const result = evaluateBootWedge(
			measurements({ live: { samples: 20, successes: 19, failures: 1, maxMs: LIVE_REQUEST_TIMEOUT_MS } }),
		);
		expect(result.pass).toBe(false);
		expect(result.checks[1]?.pass).toBe(false);
	});

	test("accepts only the daemon's healthy liveness payload", () => {
		const payload = JSON.stringify({ status: "healthy", pid: 123, port: 456 });
		expect(isLivePayload(payload, 123, 456)).toBe(true);
		expect(isLivePayload(payload, 999, 456)).toBe(false);
		expect(isLivePayload(payload, 123, 999)).toBe(false);
		expect(isLivePayload(JSON.stringify({ status: "healthy", pid: 123 }), 123, 456)).toBe(false);
		expect(isLivePayload("not json", 123, 456)).toBe(false);
	});

	test("consumes non-200 liveness response bodies before retrying", async () => {
		const response = new Response("daemon unavailable", { status: 503 });
		expect(await isLiveResponse(response, 123, 456)).toBe(false);
		expect(response.bodyUsed).toBe(true);
	});

	test("keeps a detached descendant process group pending after the root exits", () => {
		const targets = snapshotProcessTargets(100, [
			{ pid: 100, parentPid: 1, processGroupId: 100, processTicks: 0 },
			{ pid: 101, parentPid: 100, processGroupId: 200, processTicks: 0 },
		]);
		const liveAfterRootExit = hasLiveProcessTarget(
			targets,
			() => false,
			(processGroupId) => processGroupId === 200,
		);
		expect(targets.pids).toEqual([101]);
		expect(targets.processGroups).toEqual([100, 200]);
		expect(liveAfterRootExit).toBe(true);
	});

	test("fails when idle CPU reaches the ceiling or sampling is incomplete", () => {
		const overCeiling = evaluateBootWedge(
			measurements({ cpu: { samples: MIN_CPU_SAMPLES, maxPercent: CPU_CEILING_PERCENT } }),
		);
		const tooFewSamples = evaluateBootWedge(measurements({ cpu: { samples: MIN_CPU_SAMPLES - 1, maxPercent: 1 } }));
		expect(overCeiling.checks[2]?.pass).toBe(false);
		expect(tooFewSamples.checks[2]?.pass).toBe(false);
	});
});
