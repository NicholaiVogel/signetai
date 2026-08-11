---
title: "Procedural Memory"
description: "How installed skills become inspectable, source-backed knowledge."
---

Skills are Signet's procedural knowledge artifacts: authored instructions for repeatable work. The skill file and its frontmatter remain the source. Signet reconciles installed skills into scoped skill nodes and metadata so they can be inspected and navigated with the rest of the knowledge model.

## What is shipped

The daemon reads authored skill frontmatter, records a skill entity and metadata, and may derive an embedding from the authored name, description, and triggers. It reconciles the workspace skill directory at startup, periodically, and on file changes. Removing a skill removes its corresponding skill node and derived metadata.

Tracked daemon-mediated skill invocations update usage fields such as `use_count` and `last_used_at`. This is a usage ledger, not proof that Signet autonomously selected a skill for an agent.

## Current boundary

Automatic skill retrieval, prompt injection, dashboard skill discovery, and richer cross-skill semantic relations are not presented as a shipped public workflow. A user or harness still invokes skills through its supported interface.

Skill frontmatter is used as authored. Legacy LLM frontmatter enrichment configuration is retired and rejected by the daemon.

See [Skills](/skills/) for user-facing skill management and [Knowledge architecture](/knowledge-architecture/) for the distinction between source artifacts, derived indexes, and current ontology.