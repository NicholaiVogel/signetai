---
title: "Data lifecycle"
description: "Normalization, retention, projections, and user-data layout."
---

## Content normalization

Before a memory is stored, Signet normalizes line endings and trims leading and trailing whitespace. It preserves internal whitespace in stored evidence.

A separate normalized form lowercases text, collapses internal whitespace, and removes trailing punctuation. That form is used for hashing and deduplication. This means two inputs can hash as equivalent without Signet changing the internal formatting of the retained evidence.

## Derived state and retention

FTS rows, embeddings, vectors, hints, caches, and projections are derived from canonical state. Retention removes expired tombstones and their linked derived records in bounded batches. It does not redefine the source evidence that remains valid.

`MEMORY.md` is a rebuildable working-memory projection, not canonical history. Canonical historical artifacts and persisted rows retain provenance; projection safety can omit unsuitable content without deleting or rewriting the underlying evidence.

## Workspace

A workspace contains user-facing identity files, skills, configuration, source artifacts, and a SQLite memory database. By default it is local. The daemon is the supported writer; direct database edits are unsupported.

For exact configuration and deployment boundaries, see [Workspace and identity](/configuration/workspace-identity/) and [Security and lifecycle](/configuration/security-lifecycle/).