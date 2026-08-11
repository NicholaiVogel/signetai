---
title: "Hermes Agent"
description: "Connect Signet to Hermes Agent."
---

## Hermes Agent

Signet integrates with Hermes Agent through a Python `MemoryProvider` plugin. The connector installs the provider in the user plugin directory and, when a Hermes checkout is discovered, can also install its repo plugin copy. It configures `memory.provider: signet` and the daemon connection variables in the Hermes home.

### Managed files

| Location | Purpose |
|---|---|
| `~/.hermes/plugins/signet/` | User-level Signet provider files and install marker |
| `<hermes-repo>/plugins/memory/signet/` | Optional repo-plugin copy when a checkout is discovered |
| `~/.hermes/config.yaml` | Enables `memory.provider: signet` |
| `~/.hermes/.env` | Non-secret daemon connection configuration |

### Lifecycle behavior

The provider calls the Signet hook API at session start, before relevant user turns, compaction boundaries, delegation, and session end. Those hooks provide automatic context and capture evidence. The provider's tools are separate, on-demand operations.

Committed Hermes built-in memory writes are mirrored through a serialized FIFO queue so add, replace, and remove callbacks retain their batch order.

### Built-in memory mirror semantics

The Hermes connector uses synchronization rather than leaving Signet with an add-only copy of Hermes memory:

- `add` creates immutable episodic evidence in Signet.
- `replace` creates a new row and atomically supersedes the row matched by Hermes's `old_text`.
- `remove` soft-deletes the matched row.

Superseded and deleted rows remain available for provenance and audit history, but current Signet recall and list views exclude them. Mirror rows are tagged with their Hermes target and use Signet's default `global` visibility, matching the connector's existing write contract. They carry agent, project, session, source, and a deterministic idempotency key. Retrying a callback is therefore safe, and a missing or ambiguous mirrored match is never treated as permission to mutate an unrelated Signet memory.

### Native memory bridge

Hermes keeps its curated profile memory in `<HERMES_HOME>/memories/`, using
`MEMORY.md` for durable profile context and `USER.md` for user context. Signet
resolves the configured `HERMES_HOME` (defaulting to `~/.hermes`) and reads
only those two files; a named Hermes profile should set `HERMES_HOME` to its
profile directory before starting the daemon.

The daemon stores each file as a provenance-bearing native artifact with the
Hermes profile identity, profile-relative path, content hash, and source
timestamp. It never writes to Hermes memory files or creates a second semantic
extraction pipeline. Edits update the artifact row, while missing files are
soft-deleted and excluded from active recall. Artifacts remain scoped to the
current Signet agent, and an exact current `hermes-memory-write` mirror is not
returned a second time during recall.

### Tools exposed to Hermes

| Tool | Purpose |
|---|---|
| `memory_search` | Hybrid memory recall |
| `signet_session_search` | Search Signet session transcripts |
| `memory_store` | Store a durable memory |
| `memory_get`, `memory_list` | Inspect memory records |
| `memory_modify`, `memory_forget` | Edit or soft-delete a memory |
| `recall`, `remember` | Compatibility aliases |

`signet_session_search` is intentionally namespaced. Hermes already has a built-in `session_search` tool, so registering the Signet transcript tool under that bare name would collide and be dropped. Use `signet_session_search` when the task needs Signet-managed transcript evidence; Hermes's built-in `session_search` remains its own surface.

### Verify installation

```bash
signet doctor hermes
```

The diagnostic checks provider activation, plugin freshness, daemon reachability, and the registered Signet tool names. It does not replace normal Hermes diagnostics for unrelated configuration problems.
