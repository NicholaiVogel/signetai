---
title: "Retrieval, graph traversal, and hints"
description: "How bounded retrieval combines evidence, structure, and derived indexes."
---

Recall builds a bounded candidate pool from full-text search, embeddings when available, prospective hints when enabled, structured paths, and graph traversal. The graph is a candidate shaper, not a replacement for evidence or ordinary search.

Before content is loaded, reranked, summarized, or access-tracked, candidate IDs are authorized against the caller's agent, visibility, project, and scope. A broad vector or traversal result is not permission to read a memory.

## Structured knowledge

The current graph is a scoped ontology: entities, aspects, grouped claim slots, versioned attributes, and directed dependencies. Dreaming is its only automatic semantic writer. Explicit ontology operations can also apply or propose audited changes.

The retired `relations` extraction path is not the current semantic-authoring model. Do not treat relation counters or compatibility tables as current graph truth.

## Hints and ranking

Optional prospective hints are alternate query phrases associated with an existing memory. They can rescue vocabulary mismatches, but they remain a derived retrieval signal. They do not create semantic facts.

After authorization, recall may apply structured evidence shaping, reranking, dampening, currentness annotation, and bounded supplemental source results. These stages are best-effort: a failed secondary channel degrades toward simpler safe retrieval rather than failing the whole request.

For the ontology model, see [Knowledge architecture](/knowledge-architecture/). For the public request and response contract, see [Memory and recall](/memory/) and [API reference](/api/memory/recall-search/).