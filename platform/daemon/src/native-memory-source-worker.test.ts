import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createNativeSourceWorker } from "./native-memory-source-worker";

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
	it("pages source content and resumes from a durable cursor after worker restart", async () => {
		const { source } = await fixture();
		const firstWorker = createNativeSourceWorker();
		const first = await firstWorker.scan({ source, cursor: null, pageSize: 1 });
		await firstWorker.close();

		const restartedWorker = createNativeSourceWorker();
		const second = await restartedWorker.scan({ source, cursor: first.nextCursor, pageSize: 1 });
		const third = await restartedWorker.scan({ source, cursor: second.nextCursor, pageSize: 1 });
		await restartedWorker.close();

		expect(first.files.map((file) => file.content)).toEqual(["B"]);
		expect(second.files.map((file) => file.content)).toEqual(["A"]);
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
});
