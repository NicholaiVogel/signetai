---
title: "Architecture"
description: "Contributor-facing package, data, and runtime architecture."
---

This section is a technical reference for contributors. It describes the current runtime and persistence boundaries, not a product tutorial or a configuration guide.

Signet has one canonical state layer: agent-scoped SQLite rows and user-facing workspace artifacts. Search indexes, embeddings, caches, and projections are derived from that state. The daemon owns writes and exposes the HTTP surface; the CLI, dashboard, and harness integrations are clients of that daemon.

## In this section

- [Packages and data flow](/architecture/packages-data-flow/): repository ownership and the current evidence-to-retrieval path.
- [Pipeline and storage](/architecture/pipeline-storage/): active workers, persistence, and retired worker boundaries.
- [Platform services](/architecture/platform-services/): authentication, connectors, diagnostics, and repair.
- [Data lifecycle](/architecture/data-lifecycle/): normalization, retention, projections, and workspace layout.
- [Interfaces and agents](/architecture/interfaces-agents/): public runtime boundaries and agent scoping.

For product concepts, start with [What Is Signet](/what-is-signet/), [Memory and recall](/memory/), and [Knowledge architecture](/knowledge-architecture/).