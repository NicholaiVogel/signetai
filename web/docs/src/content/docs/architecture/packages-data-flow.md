---
title: "Packages and data flow"
description: "Repository ownership and the current evidence-to-retrieval path."
---

## Package boundaries

`platform/core` owns shared types, SQLite access, migrations, search, and identity primitives. `platform/daemon` owns the HTTP API, background runtime, authorization, and writes. `surfaces` contains the CLI, React dashboard, desktop application, and other human-facing clients. `integrations` contains harness adapters; `libs` contains reusable packages; `dist` contains shipping artifacts; `web` contains the public sites; and `memorybench` is a development benchmark harness.

The dashboard, CLI, and integrations are clients of the daemon. They should not implement competing memory or authorization behavior.

## Current data flow

```text
harness, CLI, dashboard, or connector
  -> daemon HTTP boundary
  -> agent-scoped evidence and SQLite state
  -> FTS, embeddings, source/document indexes, and optional hints
  -> bounded recall with authorization
  -> agent or user receives evidence-backed context

completed episodic evidence
  -> Dreaming selection
  -> audited ontology operations
  -> current scoped ontology and graph traversal inputs
```

Evidence capture and semantic maintenance are separate. A saved memory or source artifact remains attributable evidence. Dreaming is the only automatic semantic writer. There is no active extraction worker, decision worker, or automatic relation writer in the runtime.

## Workspace state

SQLite rows are canonical application state. Search indexes, vectors, caches, generated projections, and dashboard payloads are derived and rebuildable. User-facing identity files, skills, source artifacts, imports, logs, and backups remain workspace artifacts rather than database replacements.

See [Pipeline and storage](/architecture/pipeline-storage/) for worker and persistence boundaries.