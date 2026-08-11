---
title: "What Is Signet"
description: "A local-first memory and context layer for AI agents."
---

Signet is a local-first memory and context layer for AI agents. It runs a daemon beside the tools an agent already uses and keeps the agent's workspace, evidence, search indexes, and current structured knowledge inspectable.

The dashboard is the visual interface. The `signet` CLI installs, configures, and operates the local service. Harness integrations call the daemon's HTTP API while an agent works. They are different entry points to the same local state, not separate memory systems.

## What Signet stores

A Signet workspace contains user-owned material such as identity files, skills, configuration, source artifacts, session records, and a SQLite database. The database is canonical application state; FTS, vector indexes, caches, and generated working-memory projections are derived surfaces.

Signet keeps three kinds of information distinct:

- **Evidence** is the original record: an explicit memory, a completed transcript, a source artifact, or another retained input. Evidence keeps its provenance and is not rewritten into a semantic summary.
- **Derived indexes** make evidence findable: full-text search, embeddings, hints, and bounded graph traversal. They improve retrieval but are not independent truth.
- **Current ontology** is scoped operational knowledge: entities, aspects, grouped claim slots, versioned attributes, dependencies, and audited operations. It can point back to the evidence that supports it.

This distinction makes it possible to inspect a result, correct current knowledge, or remove a source without pretending that a search index or a generated claim is the original record.

## How it works

A harness or user saves evidence through the daemon. The evidence is available immediately for storage and retrieval. Background work can index documents, refresh embeddings, retain expired data, regenerate working-memory projections, and generate optional prospective search hints.

Dreaming is the automatic semantic-maintenance path. It selects bounded, agent-scoped episodic evidence and applies audited ontology operations. There is no active per-memory extraction or decision worker that silently turns every new memory into facts or graph links.

Recall combines several bounded signals, including full-text search, embeddings when available, structured evidence, and graph traversal. Every content-bearing candidate is authorized against the caller's agent, visibility, project, and scope before it is read or returned.

## What Signet is not

Signet is not a model provider, a replacement for an agent harness, or a guarantee that every retained record has been converted into current knowledge. It does not make source text disposable, and its graph is not a separate world model detached from evidence.

It is infrastructure for keeping agent context durable, inspectable, scoped, and useful across sessions and interfaces.

## Start here

- [Quickstart](/quickstart/) for installation and the first session.
- [Memory and recall](/memory/) for the persisted memory and retrieval surface.
- [Knowledge architecture](/knowledge-architecture/) for evidence, ontology, and traversal.
- [Memory pipeline](/pipeline/) for the background runtime.
- [Architecture](/architecture/) for contributor-facing implementation detail.
