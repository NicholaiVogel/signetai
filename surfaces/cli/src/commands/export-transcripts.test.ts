import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import Database from "../sqlite.js";
import { parseTranscriptMessages, registerExportTranscriptsCommand } from "./export-transcripts";
import { registerPortableCommands } from "./portable";

const prevExit = process.exit;
const prevStdoutWrite = process.stdout.write;

afterEach(() => {
	process.exit = prevExit;
	process.stdout.write = prevStdoutWrite;
});

type SeedRow = readonly [
	sessionKey: string,
	content: string,
	harness: string | null,
	project: string | null,
	agentId: string,
	createdAt: string,
];

function seedWorkspace(rows: SeedRow[]): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-export-transcripts-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	const db = Database(join(dir, "memory", "memories.db"));
	db.exec(`
		CREATE TABLE session_transcripts (
			session_key TEXT NOT NULL,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			PRIMARY KEY (agent_id, session_key)
		);
	`);
	const insert = db.prepare(
		"INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	for (const row of rows) {
		insert.run(...row);
	}
	db.close();
	return dir;
}

function runExport(dir: string, args: string[]): Promise<{ code: number; stdout: string }> {
	const program = new Command();
	registerExportTranscriptsCommand(program.command("export"), { AGENTS_DIR: dir });

	let stdout = "";
	let code = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.exit = ((exitCode?: number) => {
		code = exitCode ?? 0;
		throw new Error(`process.exit(${exitCode})`);
	}) as typeof process.exit;

	return program
		.parseAsync(["node", "test", "export", "transcripts", ...args])
		.then(() => ({ code, stdout }))
		.catch((error: Error) => {
			if (error.message.startsWith("process.exit(")) return { code, stdout };
			throw error;
		});
}

describe("parseTranscriptMessages", () => {
	test("parses role-prefixed text with multi-line accumulation", () => {
		const content = "User: first line\nsecond line\nAssistant: reply one\nAssistant: reply two";
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "user", content: "first line\nsecond line" },
			{ role: "assistant", content: "reply one" },
			{ role: "assistant", content: "reply two" },
		]);
	});

	test("normalizes human and tool_result prefixes", () => {
		expect(parseTranscriptMessages("Human: hi\ntool_result: exit 0\nAssistant: done")).toEqual([
			{ role: "user", content: "hi" },
			{ role: "tool", content: "exit 0" },
			{ role: "assistant", content: "done" },
		]);
	});

	test("parses JSONL content when it has at least two messages", () => {
		const content = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hey"}';
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hey" },
		]);
	});

	test("falls back to prefix parsing when JSONL has fewer than two messages", () => {
		const content = '{"role":"user","content":"hi"}\nAssistant: hey';
		expect(parseTranscriptMessages(content)).toEqual([{ role: "assistant", content: "hey" }]);
	});

	test("splits role-prefix lines containing literal carriage returns", () => {
		// Regression: git output embeds \r separators (e.g. "Rebasing (1/1)\rDone").
		// JS regex `.` does not match \r, so a "Tool:" line with an interior \r
		// failed the whole prefix match and was absorbed into the previous
		// message; the Python aggregator's splitlines() splits on \r. The parser
		// must match splitlines() or export output drifts from the pipeline it
		// replaces.
		const content = "Assistant: rebase it\nTool: Rebasing (1/1)\rSuccessfully rebased\nAssistant: done";
		expect(parseTranscriptMessages(content)).toEqual([
			{ role: "assistant", content: "rebase it" },
			{ role: "tool", content: "Rebasing (1/1)\nSuccessfully rebased" },
			{ role: "assistant", content: "done" },
		]);
	});

	test("returns an empty list for content with no role markers", () => {
		expect(parseTranscriptMessages("plain text without roles")).toEqual([]);
	});
});

describe("signet export transcripts", () => {
	test("exports role-prefixed transcripts as JSONL with deterministic ids", async () => {
		const dir = seedWorkspace([
			[
				"sess-1",
				"User: hello\nAssistant: hi there",
				"hermes-agent",
				"/tmp/proj",
				"default",
				"2026-07-01T10:00:00.000Z",
			],
		]);
		const outPath = join(dir, "out.jsonl");
		const { code } = await runExport(dir, ["--output", outPath]);
		expect(code).toBe(0);

		const lines = readFileSync(outPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(record).toEqual({
			id: "signet-db-sess-1",
			source: "signet",
			harness: "hermes-agent",
			agent_id: "default",
			session_key: "sess-1",
			project: "/tmp/proj",
			timestamp: "2026-07-01T10:00:00.000Z",
			message_count: 2,
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
			],
		});
	});

	test("defaults harness to signet and project to null when absent", async () => {
		const dir = seedWorkspace([["sess-null", "User: x\nAssistant: y", null, null, "ant", "2026-07-01T10:00:00.000Z"]]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath]);

		const record = JSON.parse(readFileSync(outPath, "utf8").trim()) as Record<string, unknown>;
		expect(record.harness).toBe("signet");
		expect(record.project).toBeNull();
		expect(record.agent_id).toBe("ant");
	});

	test("writes JSONL to stdout when no output path is given", async () => {
		const dir = seedWorkspace([
			["sess-out", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
		]);
		const { stdout } = await runExport(dir, []);
		const records = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(1);
		expect(records[0]?.session_key).toBe("sess-out");
	});

	test("filters by harness and agent", async () => {
		const dir = seedWorkspace([
			["sess-h1", "User: a\nAssistant: b", "hermes-agent", null, "ant", "2026-07-01T10:00:00.000Z"],
			["sess-h2", "User: a\nAssistant: b", "codex", null, "ant", "2026-07-01T11:00:00.000Z"],
			["sess-h3", "User: a\nAssistant: b", "hermes-agent", null, "other", "2026-07-01T12:00:00.000Z"],
		]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath, "--harness", "hermes-agent", "--agent", "ant"]);
		const records = readFileSync(outPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.session_key)).toEqual(["sess-h1"]);
	});

	test("filters by date range with date-only boundaries", async () => {
		// Regression: a date-only `--until 2026-07-31` compared raw would
		// exclude every row on 07-31 ("2026-07-31" < "2026-07-31T…Z"); the
		// boundary is normalized to end-of-day so the documented date-only
		// form includes the until day.
		const dir = seedWorkspace([
			["sess-old", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-06-01T10:00:00.000Z"],
			["sess-mid", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
			["sess-lastday", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-31T23:00:00.000Z"],
			["sess-new", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-08-01T10:00:00.000Z"],
		]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath, "--since", "2026-07-01", "--until", "2026-07-31"]);
		const records = readFileSync(outPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.session_key)).toEqual(["sess-mid", "sess-lastday"]);
	});

	test("applies limit and offset for resumable export", async () => {
		const dir = seedWorkspace([
			["sess-1", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
			["sess-2", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-02T10:00:00.000Z"],
			["sess-3", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-03T10:00:00.000Z"],
		]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath, "--limit", "2", "--offset", "1"]);
		const records = readFileSync(outPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.session_key)).toEqual(["sess-2", "sess-3"]);
	});

	test("applies --offset without --limit instead of silently ignoring it", async () => {
		// Regression: SQLite has no bare OFFSET, so a query builder that only
		// emitted LIMIT/OFFSET when a limit was given silently dropped the
		// offset — `--offset 2` exported from the start. LIMIT -1 keeps the
		// skip while meaning "no limit".
		const dir = seedWorkspace([
			["sess-1", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
			["sess-2", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-02T10:00:00.000Z"],
			["sess-3", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-03T10:00:00.000Z"],
		]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath, "--offset", "2"]);
		const records = readFileSync(outPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.session_key)).toEqual(["sess-3"]);
	});

	test("messages-only drops tool and system messages", async () => {
		const dir = seedWorkspace([
			[
				"sess-tool",
				"User: run it\ntool_result: ok\nSystem: context\nAssistant: done",
				"hermes-agent",
				null,
				"default",
				"2026-07-01T10:00:00.000Z",
			],
		]);
		const outPath = join(dir, "out.jsonl");
		await runExport(dir, ["--output", outPath, "--messages-only"]);
		const record = JSON.parse(readFileSync(outPath, "utf8").trim()) as {
			message_count: number;
			messages: Array<{ role: string }>;
		};
		expect(record.message_count).toBe(2);
		expect(record.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	test("--json outputs a JSON array", async () => {
		const dir = seedWorkspace([
			["sess-1", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
		]);
		const { stdout } = await runExport(dir, ["--json"]);
		const records = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(records).toHaveLength(1);
		expect(records[0]?.session_key).toBe("sess-1");
	});

	test("exits with an error when the memory database is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-export-transcripts-empty-"));
		const { code } = await runExport(dir, []);
		expect(code).toBe(1);
	});

	test("registers under the real export command without the parent bundle swallowing --output", async () => {
		// Regression: commander parses subcommand args at the parent level
		// first, so when the parent `export` command defined its own --output /
		// --json options, `export transcripts --output` silently wrote to
		// stdout and the file was never created. The portable bundle now lives
		// on a default `bundle` subcommand so sibling options cannot collide.
		const dir = seedWorkspace([
			["sess-real", "User: a\nAssistant: b", "hermes-agent", null, "default", "2026-07-01T10:00:00.000Z"],
		]);
		const outPath = join(dir, "real.jsonl");

		const program = new Command();
		registerPortableCommands(program, { AGENTS_DIR: dir });
		await program.parseAsync(["node", "test", "export", "transcripts", "--output", outPath, "--json"]);

		const records = JSON.parse(readFileSync(outPath, "utf8")) as Array<Record<string, unknown>>;
		expect(records).toHaveLength(1);
		expect(records[0]?.session_key).toBe("sess-real");
	});
});
