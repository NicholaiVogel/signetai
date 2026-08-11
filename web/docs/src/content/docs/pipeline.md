---
title: "Memory Pipeline"
description: "The background services that preserve, index, and maintain Signet state."
---

The memory pipeline is the daemon's background runtime. It preserves and indexes evidence, maintains bounded derived state, and exposes its status to operators. It is not a per-memory LLM extraction pipeline.

## Current model

Evidence is saved first. The daemon may then run non-semantic work such as document ingestion, retention, embedding refresh, working-memory projection, maintenance, and optional prospective hint generation. These workers do not replace the evidence they process.

Dreaming is the only automatic semantic writer. It selects agent-scoped episodic evidence and submits audited ontology operations. Legacy extraction, decision, structural-classification, and dependency-synthesis workers are retired; historical `extract` jobs are terminalized rather than leased.

Inference routing is configured through the canonical router workloads. The `memory_extraction` workload name remains because Dreaming uses it for inference; it does not enable a retired extraction worker.

## In this section

- [Evidence, Dreaming, and ontology changes](/pipeline/extraction-decisions/)
- [Retrieval, graph traversal, and hints](/pipeline/knowledge-search/)
- [Workers and maintenance](/pipeline/workers-maintenance/)
- [Continuity and lineage](/pipeline/continuity-lineage/)

For supported runtime configuration, use [Inference and routing](/configuration/inference-routing/) and [Pipeline configuration](/configuration/pipeline/). This section intentionally does not duplicate operator configuration.