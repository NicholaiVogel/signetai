import { afterEach, describe, expect, test } from "bun:test";
import {
	beginSyncDbCall,
	endSyncDbCall,
	getSyncDbAttributionMetrics,
	resetSyncDbAttribution,
} from "./sync-db-attribution";

afterEach(() => {
	resetSyncDbAttribution();
});

describe("sync DB attribution", () => {
	test("keeps fast calls on the timestamp-only path", () => {
		const token = beginSyncDbCall("withReadDb", 1_000);
		endSyncDbCall(token, 1_001);

		expect(getSyncDbAttributionMetrics()).toMatchObject({
			calls: 1,
			slowCalls: 0,
			unattributedCalls: 1,
		});
		expect(getSyncDbAttributionMetrics().sites).toEqual([]);
	});

	test("captures a caller only when a slow call needs attribution", () => {
		const token = beginSyncDbCall("withWriteTx", 1_000);
		endSyncDbCall(token, 1_051);

		const metrics = getSyncDbAttributionMetrics();
		expect(metrics.slowCalls).toBe(1);
		expect(metrics.unattributedCalls).toBe(0);
		expect(metrics.sites).toHaveLength(1);
		expect(metrics.sites[0]?.siteId).toContain("sync-db-attribution.test.ts:");
	});
});
