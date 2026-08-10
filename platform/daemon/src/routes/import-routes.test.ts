import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { IMPORT_MAX_BATCH_BYTES } from "../import-normalizer";
import { registerImportRoutes } from "./import-routes";

function formWithFile(file: File, duplicateMode = "skip"): FormData {
	const form = new FormData();
	form.append("files", file);
	form.set("duplicateMode", duplicateMode);
	return form;
}

describe("import routes", () => {
	let dir = "";
	let previousPath: string | undefined;
	let previousAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-import-routes-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		previousPath = process.env.SIGNET_PATH;
		previousAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "import-test-agent";
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

	function app(): Hono {
		const instance = new Hono();
		registerImportRoutes(instance);
		return instance;
	}

	it("imports a JSON file and records durable source metadata", async () => {
		const response = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(
				new File(['{"messages":[{"role":"user","content":"hello"}]}'], "export.json", { type: "application/json" }),
			),
		});

		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			imported: number;
			failed: number;
			files: Array<{ status: string; sourceId?: string }>;
		};
		expect(body.imported).toBe(1);
		expect(body.failed).toBe(0);
		expect(body.files[0]?.status).toBe("imported");
		expect(loadSourcesConfig(dir).sources[0]?.kind).toBe("import");
		expect(loadSourcesConfig(dir).sources[0]?.providerSettings?.format).toBe("json");
	});

	it("reports duplicates without creating a second source", async () => {
		const file = new File(["name,email\nAda,ada@example.com\n"], "contacts.csv", { type: "text/csv" });
		const first = await app().request("/api/sources/import", { method: "POST", body: formWithFile(file) });
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File(["name,email\nAda,ada@example.com\n"], "contacts.csv", { type: "text/csv" })),
		});

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		const body = (await second.json()) as { imported: number; failed: number; files: Array<{ status: string }> };
		expect(body).toEqual({
			imported: 0,
			failed: 0,
			files: [{ fileName: "contacts.csv", status: "duplicate", sourceId: expect.any(String) }],
		});
		expect(loadSourcesConfig(dir).sources).toHaveLength(1);
	});

	it("indexes an existing duplicate for a different agent scope", async () => {
		const content = "name,email\nAda,ada@example.com\n";
		const first = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "contacts.csv", { type: "text/csv" })),
		});
		process.env.SIGNET_AGENT_ID = "second-import-test-agent";
		const second = await app().request("/api/sources/import", {
			method: "POST",
			body: formWithFile(new File([content], "contacts.csv", { type: "text/csv" })),
		});

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({
			imported: 1,
			failed: 0,
			files: [{ fileName: "contacts.csv", status: "imported", duplicate: true }],
		});
		expect(loadSourcesConfig(dir).sources).toHaveLength(1);
	});

	it("rejects a batch that exceeds the file-count boundary", async () => {
		const form = new FormData();
		for (let index = 0; index < 26; index++)
			form.append("files", new File(["x"], `file-${index}.txt`, { type: "text/plain" }));
		const response = await app().request("/api/sources/import", { method: "POST", body: form });

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Import accepts at most 25 files" });
	});

	it("rejects oversized chunked request bodies before form-data buffering", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(IMPORT_MAX_BATCH_BYTES + 1 * 1024 * 1024 + 1));
				controller.close();
			},
		});
		const request = new Request("http://localhost/api/sources/import", {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data; boundary=import-test" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const response = await app().request(request);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Import batch exceeds the 104857600 byte limit" });
	});
});
