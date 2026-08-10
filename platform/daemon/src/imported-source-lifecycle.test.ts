import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { markImportedSourceUnsupported } from "./imported-source-lifecycle";
import { indexExternalMemoryArtifact } from "./memory-lineage";

describe("imported source lifecycle", () => {
	let dir = "";
	let previousPath: string | undefined;
	let previousAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-import-lifecycle-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		previousPath = process.env.SIGNET_PATH;
		previousAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "lifecycle-test-agent";
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		if (previousAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes searchable artifacts while preserving provenance for Dreaming review", () => {
		const sourceId = "source-import-1";
		const agentId = "lifecycle-test-agent";
		indexExternalMemoryArtifact({
			agentId,
			sourcePath: "imports/source-import-1/notes.json",
			sourceKind: "source_import_json_projection",
			harness: "dashboard-import",
			content: "A durable imported fact",
			sourceMtimeMs: Date.now(),
			sourceId,
			sourceRoot: "notes.json",
			sourceExternalId: "hash-1",
			sourceMeta: { representation: "structured-json-projection" },
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO derived_memory_sources
				 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run(
				"memory-derived-1",
				"source_import_json_projection",
				sourceId,
				"notes.json",
				agentId,
				new Date().toISOString(),
			);
		});

		const result = markImportedSourceUnsupported({ sourceId, agentId, reason: "source removed by user" });

		expect(result.artifacts).toBeGreaterThan(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_id = ?").get(sourceId) as {
						count: number;
					},
			).count,
		).toBe(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT source_id, source_path FROM derived_memory_sources WHERE source_id = ?").get(sourceId) as {
						source_id: string;
						source_path: string;
					},
			),
		).toEqual({ source_id: sourceId, source_path: "notes.json" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, reason FROM imported_source_lifecycle WHERE source_id = ?").get(sourceId) as {
						status: string;
						reason: string;
					},
			),
		).toEqual({ status: "unsupported", reason: "source removed by user" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT kind, subject_ref FROM dreaming_attention WHERE subject_ref = ?")
						.get(`source:${sourceId}`) as {
						kind: string;
						subject_ref: string;
					},
			),
		).toEqual({ kind: "hygiene", subject_ref: `source:${sourceId}` });
	});
});
