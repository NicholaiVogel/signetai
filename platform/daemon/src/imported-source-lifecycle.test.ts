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
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, is_deleted, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', ?, 'global', 0, ?, ?, 'test')`,
			).run("memory-derived-1", "A derived imported fact", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
				  source_id, source_kind, source_path, source_root)
				 VALUES (?, 'Imported document', 'imported document', 'source_document', ?, 1, ?, ?, ?, ?, ?, ?)`,
			).run(
				"entity-source-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, 'Target', 'target', 'person', ?, 1, ?, ?)`,
			).run("entity-target-1", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, 'facts', 'facts', 0.8, ?, ?)`,
			).run("aspect-source-1", "entity-source-1", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status,
				  created_at, updated_at, source_id, source_kind, source_path, source_root)
				 VALUES (?, ?, ?, NULL, 'claim', 'Imported claim', 'imported claim', 0.8, 0.5, 'active', ?, ?, ?, ?, ?, ?)`,
			).run(
				"attribute-source-1",
				"aspect-source-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
				  created_at, updated_at, source_id, source_kind, source_path, source_root)
				 VALUES (?, ?, ?, ?, 'contains', 1, 1, 'imported evidence', ?, ?, ?, ?, ?, ?)`,
			).run(
				"dependency-source-1",
				"entity-source-1",
				"entity-target-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
		});

		const result = markImportedSourceUnsupported({ sourceId, agentId, reason: "source removed by user" });

		expect(result.artifacts).toBeGreaterThan(0);
		expect(result.derivedMemories).toBe(1);
		expect(result.entities).toBeGreaterThan(0);
		expect(result.aspects).toBeGreaterThan(0);
		expect(result.attributes).toBeGreaterThan(0);
		expect(result.dependencies).toBeGreaterThan(0);
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
					db.prepare("SELECT stale_at FROM memories WHERE id = ?").get("memory-derived-1") as {
						stale_at: string | null;
					},
			).stale_at,
		).toEqual(expect.any(String));
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, archive_reason, source_id FROM entities WHERE id = ?").get("entity-source-1") as {
						status: string;
						archive_reason: string;
						source_id: string;
					},
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, archive_reason FROM entity_aspects WHERE id = ?").get("aspect-source-1") as {
						status: string;
						archive_reason: string;
					},
			),
		).toEqual({ status: "archived", archive_reason: "unsupported source: source removed by user" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT status, archive_reason, source_id FROM entity_attributes WHERE id = ?")
						.get("attribute-source-1") as { status: string; archive_reason: string; source_id: string },
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT status, archive_reason, source_id FROM entity_dependencies WHERE id = ?")
						.get("dependency-source-1") as { status: string; archive_reason: string; source_id: string },
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});

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
