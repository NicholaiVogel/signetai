import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReadDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { readEpisodicSource } from "../episodic-sources";
import { deliveredOffsetForSource, sourceHasEligibleUnconsumedEvidence } from "./dreaming-evidence-consumption";

const CONSUMPTION_INSERT = `INSERT INTO dreaming_evidence_consumption
 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
  delivered_offset, source_length, pass_id, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertArtifact(
	db: {
		prepare(sql: string): { run(...args: unknown[]): unknown };
	},
	params: {
		agentId: string;
		sourcePath: string;
		sourceSha256?: string | null;
		sourceId?: string | null;
		capturedAt: string;
		content: string;
		updatedAt: string;
		isDeleted?: number;
	},
): void {
	db.prepare(
		`INSERT INTO memory_artifacts
		 (agent_id, source_path, source_sha256, source_kind, source_id, session_id, session_token,
		  captured_at, content, updated_at, is_deleted)
		 VALUES (?, ?, ?, 'source_markdown', ?, 'session-a', 'token-a', ?, ?, ?, ?)`,
	).run(
		params.agentId,
		params.sourcePath,
		params.sourceSha256 ?? null,
		params.sourceId ?? null,
		params.capturedAt,
		params.content,
		params.updatedAt,
		params.isDeleted ?? 0,
	);
}

describe("dreaming evidence consumption query API", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-evidence-consumption-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function withRead<T>(fn: (db: ReadDb) => T): T {
		return getDbAccessor().withReadDb(fn);
	}

	function withWrite<T>(fn: (db: import("../db-accessor").WriteDb) => T): T {
		return getDbAccessor().withWriteTx(fn);
	}

	function readFixtureSource(db: ReadDb, from: string): import("../episodic-sources").EpisodicSourceRecord {
		const source = readEpisodicSource(db, { agentId: "ant", from });
		if (source === null) throw new Error(`fixture source missing: ${from}`);
		return source;
	}

	it("reports zero delivered offset before any consumption row exists", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/a.md",
				sourceSha256: "sha-a",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "unconsumed evidence",
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
		});
		withRead((db) => {
			const source = readFixtureSource(db, "artifact:imports/a.md");
			expect(deliveredOffsetForSource(db, "ant", source)).toBe(0);
		});
	});

	it("returns the persisted delivered offset for the matching source revision", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/a.md",
				sourceSha256: "sha-a",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "partially delivered evidence",
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/a.md",
				"2026-08-01T10:00:00.000Z",
				"import-a",
				"sha-a",
				8,
				29,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
		});
		withRead((db) => {
			const source = readFixtureSource(db, "artifact:imports/a.md");
			expect(deliveredOffsetForSource(db, "ant", source)).toBe(8);
		});
	});

	it("does not leak a delivered offset across equal-timestamp sources of the same kind", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/a.md",
				sourceSha256: "sha-a",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "first source content",
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/b.md",
				sourceSha256: "sha-b",
				sourceId: "import-b",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "second source content",
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/a.md",
				"2026-08-01T10:00:00.000Z",
				"import-a",
				"sha-a",
				20,
				20,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
		});
		withRead((db) => {
			const a = readFixtureSource(db, "artifact:imports/a.md");
			const b = readFixtureSource(db, "artifact:imports/b.md");
			expect(deliveredOffsetForSource(db, "ant", a)).toBe(20);
			// Equal captured_at must not advance the sibling's frontier.
			expect(deliveredOffsetForSource(db, "ant", b)).toBe(0);
		});
	});

	it("isolates the delivered offset per agent", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/a.md",
				sourceSha256: "sha-a",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "shared evidence content",
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/a.md",
				"2026-08-01T10:00:00.000Z",
				"import-a",
				"sha-a",
				24,
				24,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
		});
		withRead((db) => {
			const source = readFixtureSource(db, "artifact:imports/a.md");
			// The ant scope is drained; another agent has no consumption row.
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(false);
			expect(deliveredOffsetForSource(db, "other", source)).toBe(0);
		});
	});

	it("treats a revision replaced in place as unconsumed until its own row exists", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/revised.md",
				sourceSha256: "sha-new",
				sourceId: "import-a",
				capturedAt: "2026-08-01T11:00:00.000Z",
				content: "replaced content",
				updatedAt: "2026-08-01T12:00:00.000Z",
			});
			// Old revision fully consumed; the live row now has a new sha.
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/revised.md",
				"2026-08-01T11:00:00.000Z",
				"import-a",
				"sha-old",
				15,
				15,
				"pass-old",
				"2026-08-01T11:30:00.000Z",
			);
		});
		withRead((db) => {
			const source = readFixtureSource(db, "artifact:imports/revised.md");
			// The consumption row for the old revision does not cover sha-new.
			expect(deliveredOffsetForSource(db, "ant", source)).toBe(0);
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(true);
		});
	});

	it("reports a source drained only when every canonical revision is fully delivered", () => {
		const fullContent = "Fully delivered content";
		const partialContent = "Partially delivered content";
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/full.md",
				sourceSha256: "sha-full",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: fullContent,
				updatedAt: "2026-08-01T10:00:00.000Z",
			});
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/partial.md",
				sourceSha256: "sha-partial",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:01:00.000Z",
				content: partialContent,
				updatedAt: "2026-08-01T10:01:00.000Z",
			});
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/full.md",
				"2026-08-01T10:00:00.000Z",
				"import-a",
				"sha-full",
				fullContent.length,
				fullContent.length,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/partial.md",
				"2026-08-01T10:01:00.000Z",
				"import-a",
				"sha-partial",
				9,
				partialContent.length,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
		});
		withRead((db) => {
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(true);
		});
		withWrite((db) => {
			db.prepare(
				`UPDATE dreaming_evidence_consumption SET delivered_offset = source_length, updated_at = '2026-08-01T11:30:00.000Z'
				 WHERE agent_id = 'ant' AND source_id = 'imports/partial.md'`,
			).run();
		});
		withRead((db) => {
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(false);
		});
	});

	it("ignores deleted and empty artifacts when deciding drained state", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/gone.md",
				sourceSha256: "sha-gone",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:00:00.000Z",
				content: "deleted content",
				updatedAt: "2026-08-01T10:00:00.000Z",
				isDeleted: 1,
			});
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/empty.md",
				sourceSha256: "sha-empty",
				sourceId: "import-a",
				capturedAt: "2026-08-01T10:01:00.000Z",
				content: "",
				updatedAt: "2026-08-01T10:01:00.000Z",
			});
		});
		withRead((db) => {
			// Nothing eligible remains: deleted rows and empty content are not evidence.
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(false);
		});
	});

	it("keeps 1980-era pre-epoch artifacts listable and unconsumed until delivered", () => {
		withWrite((db) => {
			insertArtifact(db, {
				agentId: "ant",
				sourcePath: "imports/legacy.md",
				sourceSha256: "sha-legacy",
				sourceId: "import-a",
				// Watcher sentinel default; must not be silently skipped by a time watermark.
				capturedAt: "1980-01-01T00:00:00.000Z",
				content: "legacy evidence",
				updatedAt: "1980-01-01T00:00:00.000Z",
			});
		});
		withRead((db) => {
			const source = readFixtureSource(db, "artifact:imports/legacy.md");
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(true);
			expect(deliveredOffsetForSource(db, "ant", source)).toBe(0);
		});
	});

	it("returns true on a pre-migration database where the table does not exist", () => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "signet-evidence-consumption-lite-"));
		// Raw database without migrations: no dreaming_evidence_consumption table.
		const raw = new Database(join(dir, "raw.db"));
		try {
			const read = { prepare: (sql: string) => raw.prepare(sql) } as unknown as ReadDb;
			expect(sourceHasEligibleUnconsumedEvidence(read, "ant", "import-a")).toBe(true);
		} finally {
			raw.close();
		}
	});

	it("scopes unconsumed evidence to the configured source entry id", () => {
		const sharedContent = "Shared source evidence";
		withWrite((db) => {
			// Content-identical artifacts in two configured sources must not share a frontier.
			for (const [sourceId, sourcePath] of [
				["import-a", "imports/a.md"],
				["import-b", "imports/b.md"],
			] as const) {
				insertArtifact(db, {
					agentId: "ant",
					sourcePath,
					sourceSha256: "same-content",
					sourceId,
					capturedAt: "2026-08-01T10:00:00.000Z",
					content: sharedContent,
					updatedAt: "2026-08-01T10:00:00.000Z",
				});
			}
			db.prepare(CONSUMPTION_INSERT).run(
				"ant",
				"artifact",
				"imports/a.md",
				"2026-08-01T10:00:00.000Z",
				"import-a",
				"same-content",
				sharedContent.length,
				sharedContent.length,
				"pass-1",
				"2026-08-01T11:00:00.000Z",
			);
		});
		withRead((db) => {
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-a")).toBe(false);
			expect(sourceHasEligibleUnconsumedEvidence(db, "ant", "import-b")).toBe(true);
		});
	});
});
