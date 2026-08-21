import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import { buildObsidianSourceChunks, type ObsidianSourceChunk } from "./obsidian-source-embeddings";

export interface NativeSourceWorkerPattern {
	readonly glob: string;
	readonly kind: string;
	readonly excludeGlobs?: readonly string[];
	readonly excludeBasenames?: readonly string[];
}

export interface NativeSourceWorkerSource {
	readonly root: string;
	readonly files: readonly NativeSourceWorkerPattern[];
	readonly harness?: string;
	readonly sourceId?: string;
}

export interface NativeSourceWorkerFile {
	readonly path: string;
	readonly content: string;
	readonly mtimeMs: number;
	readonly kind: string;
	readonly contentHash: string;
	readonly lineCount: number;
	readonly rolloutId?: string;
	readonly chunks?: readonly ObsidianSourceChunk[];
}

export interface NativeSourceWorkerPage {
	readonly files: readonly NativeSourceWorkerFile[];
	readonly nextCursor: string | null;
	readonly scanned: number;
	readonly total: number;
	readonly complete: boolean;
	readonly frontier: readonly string[];
	readonly permissionDeniedPaths: readonly string[];
}

interface ScanCommand {
	readonly type: "scan";
	readonly id: string;
	readonly source: NativeSourceWorkerSource;
	readonly cursor: string | null;
	readonly frontier?: readonly string[];
	readonly pageSize: number;
}

type WorkerCommand = ScanCommand | { readonly type: "cancel"; readonly id: string } | { readonly type: "shutdown" };

type WorkerEvent =
	| { readonly type: "ready"; readonly pid: number }
	| {
			readonly type: "result";
			readonly id: string;
			readonly result: NativeSourceWorkerPage;
	  }
	| { readonly type: "error"; readonly id: string; readonly message: string };

interface PendingScan {
	readonly resolve: (page: NativeSourceWorkerPage) => void;
	readonly reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS = 30_000;

function matchSegment(glob: string, value: string): boolean {
	if (glob === "*") return value.length > 0;
	if (!glob.includes("*")) return glob === value;
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(value);
}

function matchParts(glob: readonly string[], value: readonly string[]): boolean {
	if (glob.length === 0) return value.length === 0;
	const head = glob[0] ?? "";
	if (head === "**") return matchParts(glob.slice(1), value) || (value.length > 0 && matchParts(glob, value.slice(1)));
	return value.length > 0 && matchSegment(head, value[0] ?? "") && matchParts(glob.slice(1), value.slice(1));
}

function matchesGlob(glob: string, value: string): boolean {
	return matchParts(glob.replace(/\\/g, "/").split("/"), value.replace(/\\/g, "/").split("/"));
}

function matchesPattern(source: NativeSourceWorkerSource, filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	const root = source.root.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	for (const pattern of source.files) {
		if (pattern.excludeBasenames?.includes(rel.split("/").slice(-1)[0] ?? "")) continue;
		if (pattern.excludeGlobs?.some((glob) => matchesGlob(glob.includes("/") ? glob : `**/${glob}`, rel))) continue;
		if (matchesGlob(pattern.glob, rel)) return pattern.kind;
	}
	return null;
}

function normalizeMarkdownBody(body: string): string {
	const lines = body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function contentMetadata(content: string): Pick<NativeSourceWorkerFile, "contentHash" | "lineCount" | "rolloutId"> {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	const rolloutId = content.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
	return {
		contentHash: createHash("sha256").update(normalizeMarkdownBody(content), "utf8").digest("hex"),
		lineCount: normalized.length === 0 ? 0 : normalized.split("\n").length,
		...(rolloutId === undefined ? {} : { rolloutId }),
	};
}

async function scan(command: ScanCommand): Promise<NativeSourceWorkerPage> {
	const pageSize = Math.max(1, Math.min(100, Math.trunc(command.pageSize)));
	const frontier = [...(command.frontier ?? [command.source.root])];
	const files: NativeSourceWorkerFile[] = [];
	const permissionDeniedPaths: string[] = [];
	while (frontier.length > 0 && files.length < pageSize) {
		const path = frontier.pop();
		if (path === undefined) break;
		try {
			const info = await lstat(path);
			if (info.isDirectory()) {
				const directory = await opendir(path);
				const entries: string[] = [];
				for await (const entry of directory) {
					if (entry.name !== ".git") entries.push(join(path, entry.name));
				}
				entries.sort((left, right) => right.localeCompare(left));
				frontier.push(...entries);
				continue;
			}
			if (!info.isFile()) continue;
			const kind = matchesPattern(command.source, path);
			if (kind === null) continue;
			const content = await readFile(path, "utf8");
			if (!content.trim()) continue;
			const chunks =
				command.source.harness === "obsidian" &&
				command.source.sourceId !== undefined &&
				kind === "source_obsidian_markdown"
					? buildObsidianSourceChunks({
							sourceId: command.source.sourceId,
							root: command.source.root,
							filePath: path,
							content,
						})
					: undefined;
			files.push({
				path,
				content,
				mtimeMs: info.mtimeMs,
				kind,
				...contentMetadata(content),
				...(chunks === undefined ? {} : { chunks }),
			});
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM")
			) {
				permissionDeniedPaths.push(path);
			}
			// Files and directories can disappear while a source is being edited.
		}
	}
	return {
		files,
		nextCursor: files[files.length - 1]?.path ?? command.cursor,
		scanned: files.length,
		total: files.length,
		complete: frontier.length === 0,
		frontier,
		permissionDeniedPaths,
	};
}

export function runNativeSourceWorker(): void {
	const parentPid = process.ppid;
	const parentWatch = setInterval(() => {
		if (process.ppid !== parentPid) process.exit(0);
	}, 250);
	parentWatch.unref();
	const canceled = new Set<string>();
	let input = "";
	const send = (event: WorkerEvent): void => {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	};
	send({ type: "ready", pid: process.pid });
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		input += chunk;
		const lines = input.split("\n");
		input = lines.pop() ?? "";
		for (const line of lines) {
			if (!line) continue;
			const command = JSON.parse(line) as WorkerCommand;
			if (command.type === "shutdown") {
				clearInterval(parentWatch);
				process.exit(0);
			}
			if (command.type === "cancel") {
				canceled.add(command.id);
				continue;
			}
			void scan(command).then(
				(result) => {
					if (canceled.delete(command.id)) return;
					send({ type: "result", id: command.id, result });
				},
				(error: unknown) =>
					send({
						type: "error",
						id: command.id,
						message: error instanceof Error ? error.message : String(error),
					}),
			);
		}
	});
}

function workerArguments(): readonly string[] {
	if (resolveEmbeddedWorkerPath("native-memory-source-worker") !== null) return [];
	const directory = dirname(fileURLToPath(import.meta.url));
	const bundled = join(directory, "native-memory-source-worker.js");
	return [existsSync(bundled) ? bundled : join(directory, "native-memory-source-worker.ts")];
}

export interface NativeSourceWorkerHandle {
	readonly scan: (input: {
		readonly source: NativeSourceWorkerSource;
		readonly cursor: string | null;
		readonly frontier?: readonly string[] | null;
		readonly pageSize: number;
	}) => Promise<NativeSourceWorkerPage>;
	readonly cancel: () => void;
	readonly close: () => Promise<void>;
}

export function createNativeSourceWorker(): NativeSourceWorkerHandle {
	let child: ChildProcess | null = null;
	let startPromise: Promise<void> | null = null;
	let sequence = 0;
	let input = "";
	let activeId: string | null = null;
	const pending = new Map<string, PendingScan>();
	const start = async (): Promise<void> => {
		if (child !== null && child.exitCode === null && !child.killed) return;
		if (startPromise !== null) return await startPromise;
		startPromise = new Promise<void>((resolve, reject) => {
			const env = { ...process.env, SIGNET_NATIVE_SOURCE_WORKER: "1" };
			const worker = spawn(process.execPath, workerArguments(), {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child = worker;
			worker.stdout?.setEncoding("utf8");
			worker.stdout?.on("data", (chunk: string) => {
				input += chunk;
				const lines = input.split("\n");
				input = lines.pop() ?? "";
				for (const line of lines) {
					if (!line) continue;
					const event = JSON.parse(line) as WorkerEvent;
					if (event.type === "ready") resolve();
					if (event.type === "result" || event.type === "error") {
						const job = pending.get(event.id);
						if (!job) continue;
						pending.delete(event.id);
						activeId = null;
						if (job.timer) clearTimeout(job.timer);
						if (event.type === "result") job.resolve(event.result);
						else job.reject(new Error(event.message));
					}
				}
			});
			worker.once("error", reject);
			worker.once("close", (code, signal) => {
				if (child !== worker) return;
				child = null;
				const error = new Error(
					signal === null
						? `native source worker exited with code ${code ?? "unknown"}`
						: `native source worker killed by ${signal}`,
				);
				for (const job of pending.values()) {
					if (job.timer) clearTimeout(job.timer);
					job.reject(error);
				}
				pending.clear();
				activeId = null;
				if (code !== 0) reject(error);
			});
		});
		try {
			await startPromise;
		} finally {
			startPromise = null;
		}
	};
	const scan = async (inputValue: {
		readonly source: NativeSourceWorkerSource;
		readonly cursor: string | null;
		readonly frontier?: readonly string[] | null;
		readonly pageSize: number;
	}): Promise<NativeSourceWorkerPage> => {
		await start();
		const worker = child;
		const stdin = worker?.stdin;
		if (worker === null || stdin === null || stdin === undefined)
			throw new Error("native source worker is unavailable");
		const id = `source-scan-${process.pid}-${++sequence}`;
		activeId = id;
		return await new Promise<NativeSourceWorkerPage>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!pending.delete(id)) return;
				activeId = null;
				worker.kill("SIGKILL");
				reject(new Error(`native source worker scan exceeded ${NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS}ms`));
			}, NATIVE_SOURCE_WORKER_SCAN_DEADLINE_MS);
			pending.set(id, { resolve, reject, timer });
			stdin.write(
				`${JSON.stringify({ type: "scan", id, ...inputValue, frontier: inputValue.frontier ?? undefined })}\n`,
			);
		});
	};
	return {
		scan,
		cancel: () => {
			const worker = child;
			if (worker === null) return;
			if (activeId !== null && worker.stdin !== null) {
				worker.stdin.write(`${JSON.stringify({ type: "cancel", id: activeId })}\n`);
			}
			worker.kill("SIGKILL");
		},
		async close(): Promise<void> {
			if (child === null) return;
			const worker = child;
			worker.stdin?.write('{"type":"shutdown"}\n');
			await new Promise<void>((resolve) => {
				if (worker.exitCode !== null) return resolve();
				worker.once("close", () => resolve());
				setTimeout(() => {
					worker.kill("SIGKILL");
					resolve();
				}, 250);
			});
		},
	};
}

const entrypoint = process.argv[1] ?? "";
if (
	process.env.SIGNET_NATIVE_SOURCE_WORKER === "1" &&
	(entrypoint.endsWith("native-memory-source-worker.ts") ||
		entrypoint.endsWith("native-memory-source-worker.js") ||
		entrypoint.endsWith("native-memory-source-worker.mjs"))
) {
	runNativeSourceWorker();
}
