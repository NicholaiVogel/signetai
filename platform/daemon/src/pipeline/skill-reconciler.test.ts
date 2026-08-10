import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { type LogEntry, logger } from "../logger";
import { DEFAULT_PIPELINE_V2, type EmbeddingConfig, type PipelineV2Config } from "../memory-config";
import { installSkillNode, skillEmbeddingHash } from "./skill-graph";
import {
	reconcileOnce,
	reconcileSkillFile,
	reconcileUnlinkedSkill,
	resetSkillFailureState,
	skillBackoffDelayMs,
} from "./skill-reconciler";

function setup(): { root: string; db: string } {
	const root = join(tmpdir(), `signet-skill-reconciler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return { root, db: join(root, "memories.db") };
}

function cfg(): PipelineV2Config {
	return {
		...DEFAULT_PIPELINE_V2,
		graph: { ...DEFAULT_PIPELINE_V2.graph, enabled: false },
		procedural: { ...DEFAULT_PIPELINE_V2.procedural },
	};
}

const emb: EmbeddingConfig = {
	model: "test",
	dimensions: 3,
	provider: "ollama",
	base_url: "http://127.0.0.1:11434",
};

let root = "";
let db = "";

afterEach(() => {
	closeDbAccessor();
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	db = "";
});

describe("skillBackoffDelayMs", () => {
	it("allows immediate retries below the failure threshold", () => {
		expect(skillBackoffDelayMs(0)).toBe(0);
		expect(skillBackoffDelayMs(1)).toBe(0);
		expect(skillBackoffDelayMs(3)).toBe(0);
	});

	it("backs off exponentially after the threshold and caps the window", () => {
		expect(skillBackoffDelayMs(4)).toBe(10_000);
		expect(skillBackoffDelayMs(5)).toBe(20_000);
		expect(skillBackoffDelayMs(6)).toBe(40_000);
		expect(skillBackoffDelayMs(10)).toBe(10 * 60_000);
		expect(skillBackoffDelayMs(50)).toBe(10 * 60_000);
	});
});

describe("reconcileOnce", () => {
	it("removes legacy skill entities and tombstones stale metadata (#1106)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const now = new Date().toISOString();
		const legacySkill = "legacy-skill";
		const legacyEntityId = "1c93cb26-legacy-skill";
		const namespaceId = `skill:default:${legacySkill}`;
		const legacyPath = join(root, "skills", legacySkill, "SKILL.md");
		getDbAccessor().withWriteTx((dbh) => {
			dbh
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, description, created_at, updated_at)
					 VALUES (?, ?, ?, 'skill', 'default', ?, ?, ?)`,
				)
				.run(legacyEntityId, legacySkill, legacySkill, "legacy skill", now, now);
			dbh
				.prepare(
					`INSERT INTO skill_meta (entity_id, agent_id, source, role, installed_at, fs_path, enriched)
					 VALUES (?, 'default', 'reconciler', 'utility', ?, ?, 0)`,
				)
				.run(namespaceId, now, legacyPath);
		});

		const staleSkill = "stale-skill";
		const staleNamespaceId = `skill:default:${staleSkill}`;
		const stalePath = join(root, "skills", staleSkill, "SKILL.md");
		getDbAccessor().withWriteTx((dbh) => {
			dbh
				.prepare(
					`INSERT INTO skill_meta (entity_id, agent_id, source, role, installed_at, fs_path, enriched)
					 VALUES (?, 'default', 'reconciler', 'utility', ?, ?, 0)`,
				)
				.run(staleNamespaceId, now, stalePath);
		});

		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => [0.1, 0.2, 0.3],
			agentsDir: root,
		});

		expect(pass).toEqual({ installed: 0, updated: 0, removed: 1 });
		expect(
			getDbAccessor().withReadDb((dbh) => dbh.prepare("SELECT id FROM entities WHERE id = ?").get(legacyEntityId)),
		).toBeNull();
		expect(
			getDbAccessor().withReadDb((dbh) =>
				dbh.prepare("SELECT entity_id FROM skill_meta WHERE entity_id = ?").get(namespaceId),
			),
		).toBeNull();

		const tombstone = getDbAccessor().withReadDb(
			(dbh) =>
				dbh.prepare("SELECT uninstalled_at FROM skill_meta WHERE entity_id = ?").get(staleNamespaceId) as
					| { uninstalled_at: string | null }
					| undefined,
		);
		expect(tombstone?.uninstalled_at).toBeString();

		const repeat = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => [0.1, 0.2, 0.3],
			agentsDir: root,
		});
		expect(repeat).toEqual({ installed: 0, updated: 0, removed: 0 });
	});

	it("can skip the unchanged filesystem scan while still checking orphan metadata (#1106)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skillDir = join(root, "skills", "deferred-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: deferred-skill
description: deferred scan
---
body`,
		);

		const pass = await reconcileOnce(
			{
				accessor: getDbAccessor(),
				pipelineConfig: cfg(),
				embeddingConfig: emb,
				fetchEmbedding: async () => {
					throw new Error("filesystem scan should be skipped");
				},
				agentsDir: root,
			},
			{ scanFilesystem: false },
		);

		expect(pass).toEqual({ installed: 0, updated: 0, removed: 0 });
	});

	it("does not reinstall an unchanged skill on the next pass", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "loop-skill";
		const dir = join(root, "skills", skill);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---
name: ${skill}
description: tiny
---
this skill helps with reconciliation loop debugging.`,
		);

		const raw = {
			name: skill,
			description: "tiny",
		} as const;

		const result = await installSkillNode(
			{
				frontmatter: raw,
				body: "this skill helps with reconciliation loop debugging.",
				source: "reconciler",
				fsPath: join(dir, "SKILL.md"),
			},
			getDbAccessor(),
			cfg(),
			emb,
			async () => [0.1, 0.2, 0.3],
		);

		const row = getDbAccessor().withReadDb(
			(dbh) =>
				dbh
					.prepare("SELECT content_hash, chunk_text FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
					.get(result.entityId) as
					| {
							content_hash: string;
							chunk_text: string;
					  }
					| undefined,
		);

		// The embedding is built from the authored frontmatter as-is; no
		// enrichment pass rewrites it.
		expect(row?.content_hash).toBe(skillEmbeddingHash(result.entityId, raw));
		expect(row?.chunk_text).toBe(`${skill} — tiny`);

		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				throw new Error("reconcileOnce should not reinstall unchanged skills");
			},
			agentsDir: root,
		});

		expect(pass).toEqual({ installed: 0, updated: 0, removed: 0 });
	});

	it("prevents overlapping triggers from reaching the embedding provider twice (#1354)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "single-flight-skill";
		const file = join(paths.root, "skills", skill, "SKILL.md");
		mkdirSync(join(paths.root, "skills", skill), { recursive: true });
		writeFileSync(
			file,
			`---
name: ${skill}
description: shared trigger test
---
body`,
		);

		let calls = 0;
		let releaseEmbedding: (() => void) | undefined;
		let resolveFirstCall: (() => void) | undefined;
		const firstCall = new Promise<void>((resolve) => {
			resolveFirstCall = resolve;
		});
		const embeddingGate = new Promise<void>((resolve) => {
			releaseEmbedding = resolve;
		});
		const deps = {
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				calls++;
				resolveFirstCall?.();
				await embeddingGate;
				return [0.1, 0.2, 0.3];
			},
			agentsDir: root,
		};

		const startupPass = reconcileOnce(deps);
		await firstCall;
		const explicitInstall = reconcileSkillFile(skill, file, deps, { forceInstall: true, source: "installed" });

		// The explicit post-install trigger is queued behind the startup pass,
		// rather than reaching fetchEmbedding while the first call is pending.
		expect(calls).toBe(1);
		releaseEmbedding?.();

		await expect(startupPass).resolves.toEqual({ installed: 1, updated: 0, removed: 0 });
		await expect(explicitInstall).resolves.toBe("unchanged");
		expect(calls).toBe(1);
	});

	it("serializes watcher unlink with an in-flight install under the same workspace key (#1354)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "unlink-single-flight-skill";
		const file = join(paths.root, "skills", skill, "SKILL.md");
		mkdirSync(join(paths.root, "skills", skill), { recursive: true });
		writeFileSync(
			file,
			`---
name: ${skill}
description: unlink trigger test
---
body`,
		);

		let releaseEmbedding: (() => void) | undefined;
		let resolveEmbeddingCall: (() => void) | undefined;
		const embeddingCall = new Promise<void>((resolve) => {
			resolveEmbeddingCall = resolve;
		});
		const embeddingGate = new Promise<void>((resolve) => {
			releaseEmbedding = resolve;
		});
		const deps = {
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				resolveEmbeddingCall?.();
				await embeddingGate;
				return [0.1, 0.2, 0.3];
			},
			agentsDir: root,
		};

		const install = reconcileSkillFile(skill, file, deps);
		await embeddingCall;
		const unlink = reconcileUnlinkedSkill(skill, deps);

		// The watcher unlink must wait for the install to finish before removing
		// the graph node that the install is about to write.
		releaseEmbedding?.();
		await expect(install).resolves.toBe("installed");
		await expect(unlink).resolves.toBe("removed");
		expect(
			getDbAccessor().withReadDb((dbh) =>
				dbh.prepare("SELECT id FROM entities WHERE id = ?").get(`skill:default:${skill}`),
			),
		).toBeNull();
	});

	it("updates skill metadata when a non-embedding frontmatter field changes on disk", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "meta-skill";
		const dir = join(root, "skills", skill);
		const file = join(dir, "SKILL.md");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			file,
			`---
name: ${skill}
description: metadata drift test
version: 1.0.0
author: nicholai
---
this skill helps verify metadata reconciliation.`,
		);

		const raw = {
			name: skill,
			description: "metadata drift test",
			version: "1.0.0",
			author: "nicholai",
		} as const;

		const first = await installSkillNode(
			{
				frontmatter: raw,
				body: "this skill helps verify metadata reconciliation.",
				source: "reconciler",
				fsPath: file,
			},
			getDbAccessor(),
			cfg(),
			emb,
			async () => [0.1, 0.2, 0.3],
		);

		expect(
			getDbAccessor().withReadDb(
				(dbh) =>
					dbh
						.prepare("SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
						.get(first.entityId) as { content_hash: string } | undefined,
			)?.content_hash,
		).toBe(skillEmbeddingHash(first.entityId, raw));

		writeFileSync(
			file,
			`---
name: ${skill}
description: metadata drift test
version: 1.0.1
author: nicholai
---
this skill helps verify metadata reconciliation.`,
		);

		let calls = 0;
		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				calls++;
				return [0.4, 0.5, 0.6];
			},
			agentsDir: root,
		});

		expect(pass).toEqual({ installed: 0, updated: 1, removed: 0 });
		expect(calls).toBe(1);
		expect(
			getDbAccessor().withReadDb(
				(dbh) =>
					dbh
						.prepare("SELECT content_hash FROM embeddings WHERE source_type = 'skill' AND source_id = ?")
						.get(first.entityId) as { content_hash: string } | undefined,
			)?.content_hash,
		).toBe(
			skillEmbeddingHash(first.entityId, {
				...raw,
				version: "1.0.1",
			}),
		);
	});

	it("installs a default-agent skill node despite a cross-agent name collision (#1070)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const now = new Date().toISOString();
		// Another agent already owns an entity named like the skill. Pre-fix the
		// global UNIQUE on entities.name rejected the default-agent insert on
		// every pass, which is what drove the #1086 hot-loop.
		getDbAccessor().withWriteTx((dbh) => {
			dbh
				.prepare(
					`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, description, created_at, updated_at)
				 VALUES ('entity:hermes-agent:dreaming', 'dreaming', 'dreaming', 'system', 'hermes-agent', 'owned by harness', ?, ?)`,
				)
				.run(now, now);
		});

		const skill = "dreaming";
		const dir = join(root, "skills", skill);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			`---
name: ${skill}
description: maintain the ontology
---
body`,
		);

		let calls = 0;
		const pass = await reconcileOnce({
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => {
				calls++;
				return [0.1, 0.2, 0.3];
			},
			agentsDir: root,
		});

		expect(pass.installed).toBe(1);
		expect(calls).toBe(1);

		const row = getDbAccessor().withReadDb(
			(dbh) =>
				dbh.prepare("SELECT id, name, agent_id FROM entities WHERE id = 'skill:default:dreaming'").get() as
					| { id: string; name: string; agent_id: string }
					| undefined,
		);
		expect(row?.agent_id).toBe("default");
		expect(row?.name).toBe("dreaming");
	});

	it("stops retrying a skill that fails deterministically on every pass (#1086)", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		// SKILL.md as a directory makes readFileSync throw EISDIR on every
		// pass: a permanent, deterministic failure like the pre-fix UNIQUE
		// collision. The reconciler must not retry it forever.
		const skill = "wedged-skill";
		const dir = join(root, "skills", skill);
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(dir, "SKILL.md"));

		const reconcilerEntries: Array<{ message: string }> = [];
		const onLog = (entry: LogEntry) => {
			if (entry.category === "reconciler") {
				reconcilerEntries.push({ message: entry.message });
			}
		};
		logger.on("log", onLog);
		try {
			for (let i = 0; i < 5; i++) {
				await reconcileOnce({
					accessor: getDbAccessor(),
					pipelineConfig: cfg(),
					embeddingConfig: emb,
					fetchEmbedding: async () => [0.1, 0.2, 0.3],
					agentsDir: root,
				});
			}
		} finally {
			logger.off("log", onLog);
		}

		const failures = reconcilerEntries.filter((e) => e.message === "Failed to reconcile skill");
		const backoffs = reconcilerEntries.filter(
			(e) => e.message === "Skill reconcile failed repeatedly; entering backoff",
		);

		// Passes 1-3 fail but retry (below the backoff threshold); the fourth
		// failure enters backoff; the fifth pass is skipped entirely.
		expect(failures.length).toBe(4);
		expect(backoffs.length).toBe(1);
	});

	it("retries a backed-off skill after resetSkillFailureState", async () => {
		const paths = setup();
		root = paths.root;
		db = paths.db;
		initDbAccessor(db);

		const skill = "reset-skill";
		const dir = join(root, "skills", skill);
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(dir, "SKILL.md"));

		const reconcilerEntries: Array<{ message: string }> = [];
		const onLog = (entry: LogEntry) => {
			if (entry.category === "reconciler") {
				reconcilerEntries.push({ message: entry.message });
			}
		};
		logger.on("log", onLog);
		const deps = {
			accessor: getDbAccessor(),
			pipelineConfig: cfg(),
			embeddingConfig: emb,
			fetchEmbedding: async () => [0.1, 0.2, 0.3],
			agentsDir: root,
		};
		try {
			for (let i = 0; i < 4; i++) {
				await reconcileOnce(deps);
			}
			resetSkillFailureState(skill);
			await reconcileOnce(deps);
		} finally {
			logger.off("log", onLog);
		}

		const failures = reconcilerEntries.filter((e) => e.message === "Failed to reconcile skill");
		const backoffs = reconcilerEntries.filter(
			(e) => e.message === "Skill reconcile failed repeatedly; entering backoff",
		);

		// Four failures (backoff after the fourth), then the reset lets the
		// fifth pass attempt the skill again (a fresh failure, not a skip).
		expect(failures.length).toBe(5);
		expect(backoffs.length).toBe(1);
	});
});
