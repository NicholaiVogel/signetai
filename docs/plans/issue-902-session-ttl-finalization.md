# Issue #902 — Session TTL eviction drops tracker state without checkpoint or finalization

## Problem

`platform/daemon/src/session-tracker.ts` evicts stale sessions from the
in-memory tracker (`cleanupStaleSessions`, sweep loop at lines 320–332, plus
mirror eviction sites in `claimSession`, `hasSession`, `getSessionPath`,
`getActiveSessions`) with a log line and a `Map.delete` — no checkpoint, no
summary enqueue, no persisted lifecycle outcome. If a harness misses its
terminal `session-end` event, the TTL sweep silently discards the only
in-memory lifecycle state that would allow deterministic recovery.

The tracker itself holds no transcript state (claims are
`{agentId, runtimePath, claimedAt, expiresAt}`); transcripts/checkpoints live
in SQLite (`session_transcripts`, `session_checkpoints`, `summary_jobs`).
So "checkpoint before eviction" means: before deleting the claim, run a
finalization pass over the persisted session state.

`boundary_reason` already defines `ttl_expired`
(`platform/daemon/src/pipeline/boundary-reason.ts:20`); it is intentionally
non-durable (`DURABLE_BOUNDARY_REASONS = {session_closed, new_session}`), so
the durability gate — not this fix — decides fact extraction. Policy is
preserved: we enqueue with `boundary_reason: "ttl_expired"` and let the
existing gates apply.

## Design

TTL expiry becomes a formal, auditable lifecycle transition:

1. **`session_outcomes` audit table (migration 090, TS; next version + SQL
   file, Rust)** — one row per TTL transition:
   `id, session_key, session_id, outcome ('finalized' | 'skipped'),
   reason ('ttl_expired'), skip_reason (nullable:
   'pipeline-disabled' | 'transcript-too-short' | 'noise-session' |
   'duplicate-job' | 'no-transcript'), payload_json, actor, actor_type,
   request_id, created_at`. Modeled on the #901 `job_cancellations` audit
   pattern; idempotent (`CREATE TABLE IF NOT EXISTS` + index guards).

2. **Finalization hook in the tracker** — `session-tracker.ts` gains an
   injectable `onSessionExpired(key)` callback (avoids a circular import
   with hooks/pipeline code; tests inject a spy). Every eviction site routes
   through a single `evictClaim(key, reason)` helper instead of bare
   `sessions.delete`.

3. **`session-ttl-finalization.ts` (new module)** — the registered callback:
   - reads the latest `session_transcripts` snapshot for the key;
   - writes a final checkpoint (`trigger: "ttl_expired"`) via the existing
     `session-checkpoints` writer;
   - when pipeline policy allows (`pipelineV2.enabled || shadowMode ||
     dreaming.enabled`, same gate as `session-end-recovery.ts`), enqueues an
     idempotent summary job (`trigger: "ttl_expired"`,
     `boundary_reason: "ttl_expired"`, content-hash dedupe via
     `summaryJobWithContentHashExists`);
   - otherwise records the explicit skip reason;
   - always writes the `session_outcomes` audit row. Re-entrant: a second
     finalization for the same key no-ops on the audit row's unique
     `(session_key, reason, outcome)` guard.

4. **Diagnostics** — additive `expiredSessions` / `unfinalizedSessions`
   counts (derived from `session_outcomes`) on the existing diagnostics
   payload, following the #901 additive pattern (no new routes, no legacy
   field changes).

5. **Rust parity** — `signet-services/src/session.rs` `cleanup()` gains the
   same outcome-recording semantics (checkpoint + summary enqueue through
   the existing `signet-daemon` hooks helpers, audit row, idempotent);
   `signet-core` migration version bump + SQL file; wire a periodic sweep
   caller mirroring the TS 15-min interval (currently missing in Rust —
   noted parity gap); inline unit tests.

## Phases

- Phase 1 — Regression tests (TS), failing before the fix
- Phase 2 — Migration 090 `session_outcomes` (TS) + registration tests
- Phase 3 — TS daemon implementation (tracker hook + finalization module)
- Phase 4 — Diagnostics counts (additive)
- Phase 5 — Rust daemon parity + PR #933 parity-gate fixes cherry-picked
- Phase 6 — Docs, gates, PR readiness

## Regression test (per issue)

Create a session with transcript activity, omit session-end, advance beyond
TTL (injectable clock/short TTL claim), assert: checkpoint persisted with
`ttl_expired`, `session_outcomes` row exists, summary job enqueued (or skip
reason recorded when synthesis disabled), second sweep is idempotent, and
diagnostics expose the counts.
