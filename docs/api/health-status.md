---
title: "Health and status API"
description: "Health, status, and runtime feature endpoints."
order: 11
section: "Reference"
---

# Health and status API

Health, status, and runtime feature endpoints.

[Back to HTTP API overview](../API.md).

## Health & Status

### GET /health

No authentication required. Lightweight liveness check.

**Response**

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.124.5",
  "port": 3850,
  "agentsDir": "/home/user/.agents",
  "db": true,
  "shuttingDown": false,
  "updateAvailable": false,
  "pendingRestart": false,
  "pipeline": {
    "extractionRunning": true,
    "extractionStalled": false,
    "extractionPending": 0,
    "extractionBackoffMs": 0
  },
  "resources": { "...": "..." }
}
```

### GET /api/status

Full daemon status including pipeline config, embedding provider, and a
composite health score derived from diagnostics. Extraction provider
runtime resolution persists startup degradation so operators can detect
silent fallback or hard-blocked extraction after boot.

**Response**

```json
{
  "status": "running",
  "version": "0.124.5",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2026-02-21T10:00:00.000Z",
  "port": 3850,
  "host": "127.0.0.1",
  "bindHost": "127.0.0.1",
  "networkMode": "localhost",
  "agentId": "default",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": {
    "enabled": true,
    "paused": false,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graph": {
      "enabled": true,
      "extractionWritesEnabled": true
    },
    "autonomous": {
      "enabled": true,
      "allowUpdateDelete": true
    },
    "extraction": {
      "provider": "llama-cpp",
      "model": "qwen3:4b"
    }
  },
  "pipeline": {
    "extraction": {
      "running": true,
      "overloaded": false,
      "loadPerCpu": 0.42,
      "maxLoadPerCpu": 0.8,
      "overloadBackoffMs": 30000,
      "overloadSince": null,
      "nextTickInMs": 1200
    }
  },
  "providerResolution": {
    "extraction": {
      "configured": "llama-cpp",
      "resolved": "llama-cpp",
      "effective": "llama-cpp",
      "fallbackProvider": "llama-cpp",
      "status": "active",
      "degraded": false,
      "fallbackApplied": false,
      "reason": null,
      "since": null
    }
  },
  "logging": {
    "logDir": "/home/user/.agents/.daemon/logs",
    "logFile": "/home/user/.agents/.daemon/logs/signet-2026-04-29.log"
  },
  "activeSessions": 1,
  "bypassedSessions": 1,
  "agentCreatedAt": "2026-02-21T10:00:00.000Z",
  "transcripts": {
    "capture": { "pending": 0, "processing": 0, "failed": 0, "dead": 0 }
  },
  "health": { "score": 0.97, "status": "healthy" },
  "update": {
    "currentVersion": "0.124.5",
    "latestVersion": null,
    "updateAvailable": false,
    "pendingRestart": null,
    "autoInstall": false,
    "checkInterval": 21600,
    "lastCheckAt": null,
    "lastError": null,
    "timerActive": true
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "available": true
  }
}
```

The `bypassedSessions` field reports how many active sessions currently have
bypass enabled (see [Sessions and hooks API](./sessions-hooks.md#sessions)).
Monitor `providerResolution.extraction.status` for `degraded` or `blocked`
states when the configured extraction provider is unavailable or routed to a
fallback target.
When `pipeline.extraction.overloaded` is `true`, the extraction worker is
intentionally backing off for `overloadBackoffMs` between polls.
`transcripts.capture` exposes compact durable transcript-capture queue counts;
use `GET /api/diagnostics/transcripts` for detailed artifact/audit diagnostics.
Use `GET /api/inference/status` for the shared inference control plane status.

As of the #901 release, `pipeline.queue` carries the per-queue counts
(`memory`, `summary`, `extraction`) plus the oldest dead summary job and the
last recorded provider error so operators can spot a backlog without
querying SQLite. The shape is:

```json
"pipeline": {
  "extraction": { "...": "..." },
  "queue": {
    "memory":     { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0 },
    "summary":    { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 1667 },
    "extraction": { "pending": 0, "leased": 0, "completed": 0, "failed": 0, "dead": 0 },
    "oldestDeadSummary": {
      "id": "sum-1234",
      "harness": "claude-code",
      "sessionKey": "session-abc",
      "createdAt": "2026-07-18T05:00:00.000Z",
      "attempts": 3,
      "error": "..."
    },
    "lastProviderError": {
      "at": "2026-07-18T10:00:00.000Z",
      "message": "connection refused",
      "provider": "ollama"
    }
  }
}
```


### GET /api/features

Returns all runtime feature flags.

**Response**

```json
{
  "featureName": true,
  "anotherFeature": false
}
```


## Liveness & readiness probes

Added in #901 so operators can wire the daemon into Kubernetes-style probes
or any HTTP load balancer that distinguishes liveness from readiness.

### GET /health/live

No authentication required. Returns 200 whenever the process is alive and
not shutting down. Use for liveness probes (restart on failure).

**Response**

```json
{ "status": "alive", "uptime": 3600.5, "pid": 12345, "shuttingDown": false }
```


### GET /health/ready

No authentication required. Returns 200 when the daemon is willing to
serve traffic. Pulls out of rotation when any readiness criterion fails:

- `shutting_down` — process is exiting.
- `db_unavailable` — SQLite probe query fails.
- `summary_dead_exceeded:<n>` — dead summary jobs ≥ 500.
- `extraction_dead_exceeded:<n>` — dead extraction jobs ≥ 500.
- `summary_oldest_pending_exceeded:<sec>s` — oldest pending summary
  job ≥ 1800 s.

Returns HTTP 503 with the `reasons` array populated when any criterion
fails.

**Response (ready)**

```json
{
  "status": "ready",
  "ready": true,
  "db": true,
  "queue": {
    "summaryDead": 0,
    "extractionDead": 0,
    "summaryOldestPendingSec": 0
  },
  "reasons": []
}
```

**Response (not ready)**

```json
{
  "status": "not_ready",
  "ready": false,
  "db": true,
  "queue": { "summaryDead": 1667, "extractionDead": 0, "summaryOldestPendingSec": 0 },
  "reasons": ["summary_dead_exceeded:1667"]
}
```


## Queue repair (issue #901)

### POST /api/diagnostics/queue/repair

Admin permission required. Runs one of the three queue repair actions
(`requeue`, `cancel`, `prune`) with optional dry-run preview.

**Request body**

```json
{
  "action": "requeue" | "cancel" | "prune",
  "dryRun": true,
  "ids": ["job-id-1", "job-id-2"],
  "tables": ["memory", "summary"],
  "olderThanMs": 2592000000,
  "errorPattern": "connection refused",
  "reason": "operator triage",
  "actor": "aaf2tbz"
}
```

**Response**

```json
{
  "action": "requeue",
  "success": true,
  "affected": 0,
  "message": "dry-run: 1667 dead job(s) match; no rows mutated",
  "preview": ["sum-1", "sum-2", "..."],
  "totalMatching": 1667
}
```

Use `dryRun: true` first to inspect the match before mutating. Pass
`dryRun: false` (or omit) to apply. The action records a `repair_action`
entry in `memory_history` regardless of dry-run so operators can audit
what was previewed vs applied.

