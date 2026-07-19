import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { type ResolvedMemoryConfig, loadMemoryConfig } from "./memory-config";
import { hybridRecall } from "./memory-search";
import { parseFreshnessIntent } from "./temporal-recall";

const NOW_ISO = "2026-07-19T00:00:00.000Z";
const MARCH_CREATED = "2026-03-10T12:00:00.000Z";
const JULY_CREATED = "2026-07-10T12:00:00.000Z";

describe("parseFreshnessIntent", () => {
	it("parses a bare month into a bounded range for the current year", () => {
		const intent = parseFreshnessIntent("What did we plan in March?", new Date("2026-07-19T00:00:00Z"));
		expect(intent?.kind).toBe("range");
		if (intent?.kind !== "range") return;
		expect(intent.since).toBe(new Date(2026, 2, 1).toISOString());
		expect(intent.until).toBe(new Date(2026, 3, 1).toISOString());
	});

	it("rolls a future bare month back to the previous year", () => {
		const intent = parseFreshnessIntent("notes from March", new Date("2026-01-15T00:00:00Z"));
		expect(intent?.kind).toBe("range");
		if (intent?.kind !== "range") return;
		expect(intent.since).toBe(new Date(2025, 2, 1).toISOString());
		expect(intent.until).toBe(new Date(2025, 3, 1).toISOString());
	});

	it("honors an explicit year", () => {
		const intent = parseFreshnessIntent("in march 2026", new Date("2026-01-15T00:00:00Z"));
		expect(intent?.kind).toBe("range");
		if (intent?.kind !== "range") return;
		expect(intent.since).toBe(new Date(2026, 2, 1).toISOString());
	});

	it("detects freshness terms without bounds", () => {
		expect(parseFreshnessIntent("current status of heron")?.kind).toBe("freshness");
		expect(parseFreshnessIntent("what is the latest on heron")?.kind).toBe("freshness");
		expect(parseFreshnessIntent("heron news today")?.kind).toBe("freshness");
	});

	it("returns null for timeless queries", () => {
		expect(parseFreshnessIntent("heron status level")).toBeNull();
	});

	it("ignores unanchored month words used as verbs or modals", () => {
		expect(parseFreshnessIntent("what may block the heron release")).toBeNull();
		expect(parseFreshnessIntent("we march on with the migration")).toBeNull();
		expect(parseFreshnessIntent("March 2026 retrospective")?.kind).toBe("range");
	});

	it("leaves day-level dates to the explicit-day parser", () => {
		expect(parseFreshnessIntent("what happened on March 15, 2026")).toBeNull();
	});
});

describe("hybridRecall temporal freshness prior", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-temporal-prior-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: TemporalPriorTest\n");
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function testCfg(overrides: Partial<ResolvedMemoryConfig["search"]> = {}): ResolvedMemoryConfig {
		const raw = loadMemoryConfig(dir);
		return {
			...raw,
			search: { ...raw.search, rehearsal_enabled: false, min_score: 0, ...overrides },
			pipelineV2: {
				...raw.pipelineV2,
				graph: { ...raw.pipelineV2.graph, enabled: false },
			},
		};
	}

	function seedFacts(): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("march-fact", "heron status level is red", MARCH_CREATED, MARCH_CREATED);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'agent-a', 'global', ?, ?, 'test')`,
			).run("july-fact", "heron status level is blue", JULY_CREATED, JULY_CREATED);
		});
	}

	async function recall(query: string, cfg: ResolvedMemoryConfig) {
		return hybridRecall(
			{
				query,
				// Pin the lexical channel so both facts tie on BM25 and only the
				// temporal prior can break the tie.
				keywordQuery: "heron",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				temporalNow: NOW_ISO,
			},
			cfg,
			async () => null,
		);
	}

	it("ranks the recent fact first for a 'current status' query", async () => {
		seedFacts();
		const res = await recall("current status of heron", testCfg());
		expect(res.results.length).toBeGreaterThanOrEqual(2);
		expect(res.results[0]?.id).toBe("july-fact");
	});

	it("ranks the in-window fact first for a month-range query", async () => {
		seedFacts();
		const res = await recall("What did we plan for heron in March?", testCfg());
		expect(res.results.length).toBeGreaterThanOrEqual(2);
		expect(res.results[0]?.id).toBe("march-fact");
	});

	it("does not change ordering for timeless queries", async () => {
		seedFacts();
		const enabled = await recall("heron status level", testCfg());
		const disabled = await recall("heron status level", testCfg({ temporal_prior_enabled: false }));
		expect(enabled.results.map((row) => row.id)).toEqual(disabled.results.map((row) => row.id));
	});

	it("skips the prior when explicit since/until bounds are passed", async () => {
		seedFacts();
		const res = await hybridRecall(
			{
				query: "current status of heron",
				keywordQuery: "heron",
				limit: 5,
				agentId: "agent-a",
				readPolicy: "isolated",
				since: "2026-03-01T00:00:00.000Z",
				until: "2026-04-01T00:00:00.000Z",
				temporalNow: NOW_ISO,
			},
			testCfg(),
			async () => null,
		);
		expect(res.results.map((row) => row.id)).toEqual(["march-fact"]);
	});
});
