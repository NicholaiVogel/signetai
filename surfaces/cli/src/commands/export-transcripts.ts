import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import Database from "../sqlite.js";

interface ExportTranscriptsDeps {
	readonly AGENTS_DIR: string;
}

export type ExportTranscriptRole = "user" | "assistant" | "system" | "tool" | "unknown";

export interface ExportTranscriptMessage {
	readonly role: ExportTranscriptRole;
	readonly content: string;
}

export interface ExportTranscriptRecord {
	readonly id: string;
	readonly source: "signet";
	readonly harness: string;
	readonly agent_id: string;
	readonly session_key: string;
	readonly project: string | null;
	readonly timestamp: string;
	readonly message_count: number;
	readonly messages: ExportTranscriptMessage[];
}

interface TranscriptRow {
	readonly session_key: string;
	readonly content: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly agent_id: string;
	readonly created_at: string;
}

const ROLE_PREFIX = /^(user|assistant|system|tool(?:_result)?|human):\s?(.*)$/i;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date-only `--until 2026-07-01` compared raw against ISO timestamps
 * excludes the entire until day ("2026-07-01" < "2026-07-01T…Z"). Normalize
 * it to end-of-day so the documented date-only form includes the day. `--since`
 * needs no normalization: "2026-07-01" already compares <= any timestamp that
 * day and matches date-only rows exactly.
 */
function normalizeUntilBoundary(until: string): string {
	return DATE_ONLY.test(until) ? `${until}T23:59:59.999Z` : until;
}

function collectOption(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

function normalizeRole(role: string): ExportTranscriptRole {
	switch (role.toLowerCase()) {
		case "user":
		case "human":
			return "user";
		case "assistant":
			return "assistant";
		case "system":
			return "system";
		case "tool":
		case "tool_result":
			return "tool";
		default:
			return "unknown";
	}
}

/**
 * Parse stored transcript content into role-labeled messages.
 *
 * Mirrors the training-data aggregator's strategy so `signet export
 * transcripts` output is a drop-in replacement for its brittle SQLite reader:
 * try JSONL lines first ({role, content} per line), fall back to role-prefixed
 * text (user/assistant/system/tool) with multi-line accumulation.
 */
export function parseTranscriptMessages(content: string): ExportTranscriptMessage[] {
	const jsonl = parseJsonlMessages(content);
	if (jsonl.length >= 2) return jsonl;
	return parsePrefixedMessages(content);
}

function parseJsonlMessages(content: string): ExportTranscriptMessage[] {
	const messages: ExportTranscriptMessage[] = [];
	// Match the aggregator's splitlines(): split on \r and \n alike so lines
	// containing literal carriage returns cannot smuggle a role prefix into a
	// continuation line.
	for (const line of content.split(/\r\n|\r|\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const entry = JSON.parse(trimmed) as { role?: unknown; content?: unknown };
			if (typeof entry.role === "string" && typeof entry.content === "string" && entry.content.length > 0) {
				messages.push({ role: normalizeRole(entry.role), content: entry.content });
			}
		} catch {
			// Not a JSONL line; the prefix parser handles mixed text.
		}
	}
	return messages;
}

function parsePrefixedMessages(content: string): ExportTranscriptMessage[] {
	const messages: ExportTranscriptMessage[] = [];
	let currentRole: ExportTranscriptRole | null = null;
	let currentLines: string[] = [];

	const flush = (): void => {
		if (currentRole !== null) {
			const text = currentLines.join("\n").trim();
			if (text.length > 0) {
				messages.push({ role: currentRole, content: text });
			}
		}
		currentRole = null;
		currentLines = [];
	};

	for (const rawLine of content.split(/\r\n|\r|\n/)) {
		const line = rawLine.trim();
		const match = ROLE_PREFIX.exec(line);
		if (match) {
			flush();
			currentRole = normalizeRole(match[1] ?? "");
			const rest = match[2] ?? "";
			currentLines = rest.length > 0 ? [rest] : [];
		} else if (currentRole !== null) {
			currentLines.push(line);
		}
	}
	flush();

	return messages;
}

function buildRecord(row: TranscriptRow): ExportTranscriptRecord {
	const messages = parseTranscriptMessages(row.content);
	return {
		id: `signet-db-${row.session_key}`,
		source: "signet",
		harness: row.harness ?? "signet",
		agent_id: row.agent_id,
		session_key: row.session_key,
		project: row.project ?? null,
		timestamp: row.created_at,
		message_count: messages.length,
		messages,
	};
}

function selectTranscriptRows(
	db: ReturnType<typeof Database>,
	filters: {
		readonly harnesses: readonly string[];
		readonly agents: readonly string[];
		readonly since?: string;
		readonly until?: string;
		readonly limit?: number;
		readonly offset?: number;
	},
): TranscriptRow[] {
	const where: string[] = [];
	const params: unknown[] = [];

	if (filters.harnesses.length > 0) {
		where.push(`harness IN (${filters.harnesses.map(() => "?").join(", ")})`);
		params.push(...filters.harnesses);
	}
	if (filters.agents.length > 0) {
		where.push(`agent_id IN (${filters.agents.map(() => "?").join(", ")})`);
		params.push(...filters.agents);
	}
	if (filters.since !== undefined) {
		where.push("created_at >= ?");
		params.push(filters.since);
	}
	if (filters.until !== undefined) {
		where.push("created_at <= ?");
		params.push(filters.until);
	}

	// SQLite has no bare OFFSET; LIMIT -1 means "no limit", so --offset alone
	// must still apply the skip (a silently ignored --offset is a no-op).
	const limit = filters.limit ?? -1;
	const offset = filters.offset ?? 0;
	const sql = `
		SELECT session_key, content, harness, project, agent_id, created_at
		FROM session_transcripts
		${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY created_at, agent_id, session_key
		LIMIT ? OFFSET ?
	`;

	const stmt = db.prepare(sql);
	const rows = stmt.all(...params, limit, offset) as ReadonlyArray<Record<string, unknown>>;
	return rows.map((row) => ({
		session_key: String(row.session_key),
		content: String(row.content),
		harness: row.harness == null ? null : String(row.harness),
		project: row.project == null ? null : String(row.project),
		agent_id: String(row.agent_id),
		created_at: String(row.created_at),
	}));
}

export function registerExportTranscriptsCommand(exportCmd: Command, deps: ExportTranscriptsDeps): void {
	exportCmd
		.command("transcripts")
		.description("Export session transcripts as JSONL (one conversation per line) for training/fine-tuning")
		.option("-o, --output <path>", "Write to a file instead of stdout")
		.option("--harness <name>", "Filter by harness (repeatable)", collectOption, [])
		.option("--agent <name>", "Filter by agent ID (repeatable)", collectOption, [])
		.option("--since <iso>", "Only transcripts created at or after this ISO timestamp")
		.option("--until <iso>", "Only transcripts created at or before this ISO timestamp")
		.option("--limit <n>", "Max conversations to export", Number.parseInt)
		.option("--offset <n>", "Skip N conversations (for resumable export)", Number.parseInt, 0)
		.option("--messages-only", "Skip system and tool messages in each conversation")
		.option("--json", "Output a JSON array instead of JSONL")
		.action(
			async (options: {
				output?: string;
				harness: string[];
				agent: string[];
				since?: string;
				until?: string;
				limit?: number;
				offset?: number;
				messagesOnly?: boolean;
				json?: boolean;
			}) => {
				if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
					console.error(chalk.red("  Error: --limit must be a non-negative integer"));
					process.exit(1);
				}
				if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
					console.error(chalk.red("  Error: --offset must be a non-negative integer"));
					process.exit(1);
				}

				const dbPath = join(deps.AGENTS_DIR, "memory", "memories.db");
				if (!existsSync(dbPath)) {
					console.error(chalk.red("  No memory database found. Nothing to export."));
					process.exit(1);
				}

				const db = Database(dbPath, { readonly: true });
				try {
					const hasTable = db
						.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcripts'")
						.get();
					if (!hasTable) {
						console.error(chalk.red("  No session transcripts found (session_transcripts table missing)."));
						process.exit(1);
					}

					const rows = selectTranscriptRows(db, {
						harnesses: options.harness,
						agents: options.agent,
						since: options.since,
						until: options.until === undefined ? undefined : normalizeUntilBoundary(options.until),
						limit: options.limit,
						offset: options.offset,
					});

					const records = rows.map((row) => {
						const record = buildRecord(row);
						if (!options.messagesOnly) return record;
						return {
							...record,
							messages: record.messages.filter((message) => message.role === "user" || message.role === "assistant"),
							message_count: record.messages.filter(
								(message) => message.role === "user" || message.role === "assistant",
							).length,
						};
					});

					const body = options.json
						? `${JSON.stringify(records, null, 2)}\n`
						: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

					if (options.output) {
						writeFileSync(options.output, body);
						console.log(chalk.dim(`  ${records.length} transcripts exported to ${chalk.cyan(options.output)}`));
					} else {
						process.stdout.write(body);
					}
				} finally {
					db.close();
				}
			},
		);
}
