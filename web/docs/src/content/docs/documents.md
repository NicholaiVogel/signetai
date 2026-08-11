---
title: "Documents"
description: "Ingest documents into linked, searchable memory chunks."
---

The documents API accepts text, URLs, and file references for background ingestion. A document is stored first, then processed into linked `document_chunk` memories that participate in search. For source-backed file uploads through the Dashboard, see [Sources](/sources/); for exact HTTP shapes, see [Documents and sources API](/api/documents-sources/).

## Submit a document

`POST /api/documents` accepts `text`, `url`, and `file` source types. Text requests include `content`; URL requests include `url` and are fetched by the worker.

A successful new request returns `201 Created` after the document and its queued job have been recorded:

```json
{
  "id": "<document-id>",
  "status": "queued",
  "jobId": "<memory-job-id>"
}
```

The worker owns later processing. Poll `GET /api/documents/:id` for the document record, or use the job ID with `GET /api/memory/jobs/:id` when you need job-level state.

URL and file submissions deduplicate by source URL within the same agent and project scope while the existing document is not `failed` or `deleted`. A deduplicated request returns `200` with the existing document ID, its real current status, and `deduplicated: true`; it does not pretend the document is in a generic `processing` state.

## Lifecycle

A document moves through these states:

```text
queued → extracting → chunking → embedding → indexing → done
```

`extracting` is used while the worker fetches a URL. The worker can end the document in `failed`; deletion marks it `deleted`. There is no document status named `processing`.

Each completed chunk is a memory with `type: "document_chunk"`, connected through `document_memories` with a sequential `chunk_index`. `GET /api/documents/:id/chunks` returns active linked chunks in chunk-index order.

## Chunking

The worker splits content by characters with overlap. Whitespace-only chunks are skipped. The defaults are:

| Setting | Default | Accepted range |
|---|---:|---:|
| Chunk size | 2,000 characters | 200–50,000 |
| Chunk overlap | 200 characters | 0–10,000 |
| Worker interval | 10,000 ms | 1,000–300,000 ms |
| Maximum content | 10 MiB | 1 KiB–100 MiB |

Identical chunk content can be shared by more than one document in the same scope. The relationship is represented by multiple document-to-memory links, not by duplicating a memory record.

## Delete a document

`DELETE /api/documents/:id?reason=<reason>` marks the document `deleted`, completes any still-pending document-ingest job, and returns:

```json
{ "deleted": true, "memoriesRemoved": 3 }
```

`memoriesRemoved` is the number of linked memories that this deletion actually soft-deleted. It is not the document’s chunk count. A linked memory is preserved when another non-deleted document still references it, so deleting one document never destroys a shared chunk that another active document needs.

## Configuration

Document settings belong under `memory.pipelineV2.documents` in `agent.yaml`:

```yaml
memory:
  pipelineV2:
    documents:
      chunkSize: 2000
      chunkOverlap: 200
      workerIntervalMs: 10000
      maxContentBytes: 10485760
```

The daemon validates and clamps these values when it loads configuration. The legacy flat document keys, if used, are still inside `memory.pipelineV2`; there is no supported top-level `pipeline` document configuration.

Changing chunk settings affects future ingestion only. To apply new chunking to an existing document, delete it and submit it again.

## Worker behavior

The document worker polls `memory_jobs` for `document_ingest` work. It claims a job, updates document lifecycle state as it processes the content, writes chunks and their embeddings, then marks the document complete. Network embedding calls happen outside write transactions, while each memory write remains a short transaction.

For endpoint permissions, request fields, list pagination, source types, and response fields, use the [Documents and sources API](/api/documents-sources/).