import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import {
	createNativeSourceWorker,
	NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES,
	waitForNativeSourceWorkerDrain,
} from "./native-memory-source-worker";

async function fixture(): Promise<{
	readonly root: string;
	readonly source: {
		readonly root: string;
		readonly files: readonly [{ readonly glob: "**/*.md"; readonly kind: "markdown" }];
	};
}> {
	const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-"));
	await mkdir(join(root, "nested"));
	await writeFile(join(root, "b.md"), "B");
	await writeFile(join(root, "nested", "a.md"), "A");
	return { root, source: { root, files: [{ glob: "**/*.md", kind: "markdown" }] } };
}

describe("native source worker", () => {
	it("does not complete a scan before a real backpressured command drains", async () => {
		const { root } = await fixture();
		const source = {
			root,
			files: [
				{ glob: "**/*.md", kind: "markdown" },
				...Array.from({ length: 4096 }, (_, index) => ({
					glob: `never-match-${index}-${"x".repeat(64)}`,
					kind: "markdown",
				})),
			],
		};
		type TestStdin = NodeJS.WritableStream & {
			readonly writableHighWaterMark: number;
			write: (...args: unknown[]) => boolean;
		};
		let stdin!: TestStdin;
		let commandWritten!: () => void;
		const command = new Promise<void>((resolve) => {
			commandWritten = resolve;
		});
		let commandBytes = 0;
		let commandWriteReturnedFalse = false;
		let releaseWrite!: () => void;
		let scanStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			scanStarted = resolve;
		});
		let resultDelivered!: () => void;
		const result = new Promise<void>((resolve) => {
			resultDelivered = resolve;
		});
		const worker = createNativeSourceWorker({
			wrapStdin: (rawStdin) => {
				const backpressuredStdin = new Writable({
					highWaterMark: 1024,
					write(chunk, _encoding, callback) {
						rawStdin.write(chunk as string);
						releaseWrite = callback;
					},
				}) as TestStdin;
				stdin = backpressuredStdin;
				const write = stdin.write.bind(stdin);
				stdin.write = ((...args: unknown[]) => {
					const result = write(...args);
					const chunk = args[0];
					if (typeof chunk === "string" && chunk.includes('"type":"scan"')) {
						commandBytes = Buffer.byteLength(chunk, "utf8");
						commandWriteReturnedFalse = result === false;
						commandWritten();
					}
					return result;
				}) as TestStdin["write"];
				return stdin;
			},
			onScanStarted: scanStarted,
			onScanResult: resultDelivered,
		});
		let settled = false;
		try {
			const scan = worker.scan({ source, cursor: null, pageSize: 1 }).then((page) => {
				settled = true;
				return page;
			});
			await command;
			expect(commandBytes).toBeGreaterThan(stdin.writableHighWaterMark);
			expect(commandWriteReturnedFalse).toBe(true);
			await started;
			await result;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			releaseWrite();
			await scan;
			expect(settled).toBe(true);
		} finally {
			await worker.close();
		}
	});

	it("propagates a worker stream error while waiting for drain", async () => {
		const stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
		const streamError = new Error("worker stdin failed");
		const drain = waitForNativeSourceWorkerDrain(stdin);
		stdin.emit("error", streamError);
		await expect(drain).rejects.toBe(streamError);
	});

	it("propagates a worker stream close while waiting for drain", async () => {
		const stdin = new EventEmitter() as unknown as NodeJS.WritableStream;
		const drain = waitForNativeSourceWorkerDrain(stdin);
		stdin.emit("close");
		await expect(drain).rejects.toThrow("closed before drain");
	});

	it("pages source content and resumes from a durable cursor after worker restart", async () => {
		const { source } = await fixture();
		const firstWorker = createNativeSourceWorker();
		const first = await firstWorker.scan({ source, cursor: null, pageSize: 1 });
		await firstWorker.close();

		const restartedWorker = createNativeSourceWorker();
		const second = await restartedWorker.scan({
			source,
			cursor: first.nextCursor,
			frontier: first.frontier,
			pageSize: 1,
		});
		const third = await restartedWorker.scan({
			source,
			cursor: second.nextCursor,
			frontier: second.frontier,
			pageSize: 1,
		});
		await restartedWorker.close();

		expect(first.files.map((file) => file.content)).toEqual(["B"]);
		expect(second.files.map((file) => file.content)).toEqual(["A"]);
		expect(second.frontier).not.toContain(source.root);
		expect(third.files).toEqual([]);
		expect(third.complete).toBe(true);
	});

	it("kills the isolated worker when cancellation is requested", async () => {
		const { source } = await fixture();
		const worker = createNativeSourceWorker();
		const scan = worker.scan({ source, cursor: null, pageSize: 1 });
		worker.cancel();
		await expect(scan).rejects.toThrow(/native source worker/);
		await worker.close();
	});

	it("prepares Obsidian chunks inside the isolated worker", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-obsidian-"));
		await writeFile(
			join(root, "note.md"),
			"# Worker-owned chunking\n\nThis content is deliberately long enough to exercise the source chunk parser in the child process.\n",
		);
		const worker = createNativeSourceWorker();
		const page = await worker.scan({
			source: {
				root,
				harness: "obsidian",
				sourceId: "obsidian:test",
				files: [{ glob: "**/*.md", kind: "source_obsidian_markdown" }],
			},
			cursor: null,
			pageSize: 1,
		});
		await worker.close();
		expect(page.files[0]?.chunks?.length).toBe(1);
	});

	it("derives Codex source IDs in the isolated worker", async () => {
		const { root } = await fixture();
		const worker = createNativeSourceWorker();
		const page = await worker.scan({
			source: { root, harness: "codex", files: [{ glob: "**/*.md", kind: "markdown" }] },
			cursor: null,
			pageSize: 1,
		});
		await worker.close();
		expect(page.files[0]?.sourceId).toMatch(/^codex_native_memory:[0-9a-f]{16}$/);
	});

	it(`rejects a descriptor larger than the ${NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES}-byte IPC bound`, async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-native-source-worker-bound-"));
		await writeFile(join(root, "huge.md"), "x".repeat(NATIVE_SOURCE_WORKER_MAX_MESSAGE_BYTES + 1024));
		const worker = createNativeSourceWorker();
		await expect(
			worker.scan({
				source: { root, files: [{ glob: "**/*.md", kind: "markdown" }] },
				cursor: null,
				pageSize: 1,
			}),
		).rejects.toThrow(/IPC limit/);
		await worker.close();
	});
});
