import { addImportedSource, markSourceIndexed, removeSource } from "@signet/core";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { getDbAccessor } from "../db-accessor";
import {
	IMPORT_MAX_BATCH_BYTES,
	IMPORT_MAX_FILES,
	IMPORT_MAX_FILE_BYTES,
	normalizeImportedFile,
} from "../import-normalizer";
import { logger } from "../logger";
import { indexExternalMemoryArtifact } from "../memory-lineage";
import { indexSourceArtifactStructure } from "../source-artifact-graph";
import { purgeSourceOwnedRows } from "../source-purge";

const MAX_MULTIPART_OVERHEAD = 1 * 1024 * 1024;
const MAX_MULTIPART_BYTES = IMPORT_MAX_BATCH_BYTES + MAX_MULTIPART_OVERHEAD;

class ImportPayloadTooLargeError extends Error {}

type ImportFileStatus =
	| {
			readonly fileName: string;
			readonly status: "imported";
			readonly sourceId: string;
			readonly format: string;
			readonly duplicate: boolean;
	  }
	| { readonly fileName: string; readonly status: "duplicate"; readonly sourceId: string }
	| { readonly fileName: string; readonly status: "failed"; readonly error: string };

export function registerImportRoutes(app: Hono): void {
	app.post("/api/sources/import", async (c) => {
		const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > IMPORT_MAX_BATCH_BYTES + MAX_MULTIPART_OVERHEAD) {
			return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);
		}

		let form: FormData;
		try {
			form = await boundedFormData(c.req.raw);
		} catch (error) {
			if (error instanceof ImportPayloadTooLargeError)
				return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);
			return c.json({ error: "Expected a multipart form with files" }, 400);
		}
		const entries = form.getAll("files").filter((entry): entry is File => entry instanceof File);
		if (entries.length === 0) return c.json({ error: "At least one file is required" }, 400);
		if (entries.length > IMPORT_MAX_FILES)
			return c.json({ error: `Import accepts at most ${IMPORT_MAX_FILES} files` }, 413);

		const duplicateModeValue = form.get("duplicateMode");
		const duplicateMode =
			duplicateModeValue === "replace" || duplicateModeValue === "reimport" ? duplicateModeValue : "skip";
		const totalBytes = entries.reduce((total, file) => total + file.size, 0);
		if (totalBytes > IMPORT_MAX_BATCH_BYTES)
			return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);

		const statuses: ImportFileStatus[] = [];
		let imported = 0;
		for (const file of entries) {
			if (file.size > IMPORT_MAX_FILE_BYTES) {
				statuses.push({
					fileName: file.name,
					status: "failed",
					error: `File exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`,
				});
				continue;
			}
			const normalized = await normalizeImportedFile(file.name, new Uint8Array(await file.arrayBuffer()), file.type);
			if (normalized.ok === false) {
				statuses.push({ fileName: file.name, status: "failed", error: normalized.error });
				continue;
			}

			const added = addImportedSource(
				{
					fileName: normalized.value.fileName,
					contentHash: normalized.value.contentHash,
					format: normalized.value.format,
					duplicateMode,
				},
				process.env.SIGNET_PATH,
			);
			if (added.ok === false) {
				statuses.push({ fileName: file.name, status: "failed", error: added.error });
				continue;
			}
			if (added.duplicate && duplicateMode === "skip" && hasIndexedSource(added.source.id, resolveDaemonAgentId())) {
				statuses.push({ fileName: file.name, status: "duplicate", sourceId: added.source.id });
				continue;
			}

			try {
				if (added.duplicate && duplicateMode === "replace")
					purgeSourceOwnedRows({ sourceId: added.source.id, agentId: resolveDaemonAgentId() });
				const sourcePath = `imports/${added.source.id}/${normalized.value.fileName}`;
				const now = new Date().toISOString();
				indexExternalMemoryArtifact({
					agentId: resolveDaemonAgentId(),
					sourcePath,
					sourceKind: "import",
					harness: "dashboard-import",
					content: normalized.value.content,
					sourceMtimeMs: Date.now(),
					capturedAt: now,
					sourceId: added.source.id,
					sourceRoot: normalized.value.fileName,
					sourceExternalId: normalized.value.contentHash,
					sourceMeta: normalized.value.sourceMeta,
				});
				indexSourceArtifactStructure({
					agentId: resolveDaemonAgentId(),
					sourceId: added.source.id,
					sourceKind: "import",
					sourceRoot: normalized.value.fileName,
					sourcePath,
					displayName: normalized.value.fileName,
					content: normalized.value.content,
				});
				markSourceIndexed(added.source.id, now, process.env.SIGNET_PATH);
				imported += 1;
				statuses.push({
					fileName: file.name,
					status: "imported",
					sourceId: added.source.id,
					format: normalized.value.format,
					duplicate: added.duplicate,
				});
			} catch (error) {
				if (added.created) {
					try {
						purgeSourceOwnedRows({ sourceId: added.source.id, agentId: resolveDaemonAgentId() });
						removeSource(added.source.id, process.env.SIGNET_PATH);
					} catch (cleanupError) {
						logger.warn("documents", "Dashboard import cleanup failed", {
							sourceId: added.source.id,
							error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						});
					}
				}
				logger.warn("documents", "Dashboard import failed after source registration", {
					sourceId: added.source.id,
					error: error instanceof Error ? error.message : String(error),
				});
				statuses.push({ fileName: file.name, status: "failed", error: "Could not persist imported source" });
			}
		}

		const failed = statuses.filter((status) => status.status === "failed").length;
		return c.json({ imported, failed, files: statuses }, failed > 0 ? 207 : 201);
	});
}

function hasIndexedSource(sourceId: string, agentId: string): boolean {
	return getDbAccessor().withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT 1 AS present
				 FROM memory_artifacts
				 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0
				 LIMIT 1`,
			)
			.get(agentId, sourceId) as { present: number } | null | undefined;
		return row != null;
	});
}

async function boundedFormData(request: Request): Promise<FormData> {
	if (request.body === null) return request.formData();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = request.body?.getReader();
			if (reader === undefined) {
				controller.close();
				return;
			}
			let totalBytes = 0;
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						return;
					}
					totalBytes += next.value.byteLength;
					if (totalBytes > MAX_MULTIPART_BYTES) {
						await reader.cancel();
						controller.error(new ImportPayloadTooLargeError());
						return;
					}
					controller.enqueue(next.value);
				}
			} catch (error) {
				controller.error(error);
			}
		},
	});
	const boundedRequest = new Request(request, {
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	return boundedRequest.formData();
}
