# Plan: Surface and repair the dead summary-job backlog (issue #901)

> Closes <https://github.com/Signet-AI/signetai/issues/901>.
> Branch: `plan/issue-901` cut from `origin/main` at `68d4352f` (release 0.147.15).

## Problem

A live `0.147.1` database contained 92 completed summary jobs and **1,667
dead summary jobs**. None of the normal operator surfaces — `signet status`,
`/api/status`, `/health`, `/api/diagnostics` — surfaced this backlog, and
the only way to see it was to query SQLite directly. Once an operator
found the backlog, there was no preview/dry-run path for the existing
repair command, no way to cancel obsolete jobs, and no way to prune old
terminal jobs without losing provenance.

## Recon (already done)

- `platform/daemon/src/diagnostics.ts:203` — `getQueueHealth` only reads
  `memory_jobs`. `summary_jobs` (schema at
  `platform/core/src/migrations/009-summary-jobs.ts`) is invisible to
  diagnostics.
- `platform/daemon/src/routes/health.ts` — `/health` only reports
  `extractionPending` from the worker stats; no dead/backlog breakdown.
- `platform/daemon/src/routes/pipeline-routes.ts:165` — `/api/status`
  does not include queue counts.
- `platform/daemon/src/routes/pipeline-routes.ts:382` — `/api/pipeline/status`
  already returns `queues.memory` and `queues.summary` count maps, but
  only as raw `pending/leased/completed/failed/dead` integers and not
  in `/api/status`, not in `/health`, not in `signet status`, and not
  folded into the composite health score.
- `platform/daemon/src/repair-actions.ts:201` — `requeueDeadJobs`
  requeues `memory_jobs` + `summary_jobs` but **has no dry-run**, only
  takes the first N by id, and cannot target specific jobs.
- `platform/daemon/src/repair-actions.ts` — there is **no `cancelObsoleteJobs`
  and no `pruneTerminalJobs`** action today.
- `surfaces/cli/src/cli.ts` — `signet status` does not render queue
  counts today.

## Out of scope

- Renaming or restructuring `memory_jobs` / `summary_jobs` tables.
- Adding new queue types beyond summary/extraction.
- Auto-execution by the maintenance worker of the new repair commands
  (operators trigger these explicitly; the worker can recommend them).
- Backfilling history rows for jobs pruned before this PR ships.

---

## Phase 1 — Recon & schema audit

> Establish the exact contract we will extend.

- [ ] Confirm `summary_jobs` columns and indexes in current main
      (`009-summary-jobs.ts` + later migrations).
- [ ] Confirm whether `extraction_jobs` is a distinct table or a
      `job_type` on `memory_jobs`; design data fetch accordingly.
- [ ] Inventory every existing read of `summary_jobs` so the new
      diagnostics queries are consistent with the production code paths.
- [ ] Capture a baseline: a fixture script that seeds N dead + N stale
      leased summary jobs and prints the **current** outputs of
      `signet status`, `/api/status`, `/health`, `/api/diagnostics`,
      `/api/pipeline/status` so we can diff after each phase.

## Phase 2 — Visibility: queue counts on every operator surface

> Make the backlog impossible to miss.

### 2a. Diagnostics core

- [ ] Extend `QueueHealth` type in `diagnostics.ts` to expose per-queue
      breakdown:

      ```ts
      interface QueueCounts {
        pending: number;
        leased: number;
        completed: number;
        failed: number;
        dead: number;
        oldestAgeSec: number;   // age of oldest non-terminal row
        oldestDeadAgeSec: number;
        lastError: string | null;
      }

      interface QueueHealth extends HealthScore {
        memory: QueueCounts;
        summary: QueueCounts;
        extraction: QueueCounts; // if distinct; otherwise derived from memory_jobs where job_type='extraction'
        depth: number;           // legacy aggregate, kept for back-compat
        ...
      }
      ```

- [ ] Implement `getQueueCounts(db, table): QueueCounts` and call it for
      `memory_jobs`, `summary_jobs`, and `extraction_jobs` (table-aware).
- [ ] Refactor `getQueueHealth` to compose per-table counts and keep the
      legacy aggregate fields for downstream consumers
      (`/api/pipeline/status`, dashboard).
- [ ] Add unit tests in `diagnostics.test.ts` covering: empty table,
      pending-only, mixed dead+leased, missing table (older DBs),
      schema drift.

### 2b. HTTP surfaces

- [ ] `/api/diagnostics/queue` returns the new structured object.
- [ ] `/api/diagnostics` includes the extended queue block.
- [ ] `/api/status` adds a `pipeline.queue` block summarising both
      queues (mirrors `/api/pipeline/status`'s shape but flat for
      dashboards).
- [ ] `/health/ready` (already added by #905) folds in `queue.dead`
      from the summary queue: return HTTP 503 + `ready: false` when
      dead summary jobs exceed the configurable threshold (default 500)
      **or** oldest pending job is older than 30 minutes.
- [ ] `/health` (legacy) keeps its current shape but adds
      `pipeline.queueSummaryDead` so existing scrapers see the signal.

### 2c. CLI surface

- [ ] `signet status` renders a `Pipeline queues` section with both
      tables side-by-side and a `dead` count highlighted when > 0.
- [ ] `signet doctor` (if it exists; otherwise `signet status
      --verbose`) lists the oldest dead summary job (id, harness,
      session_key, created_at, error) and the last provider error.

### 2d. Documentation

- [ ] Update `docs/PIPELINE.md` §"Maintenance Worker" to reference the
      new queue surfaces and explain the composite scoring weights.
- [ ] Add `docs/api/diagnostics.md` (or extend if it exists) with
      example payloads for `/api/diagnostics/queue` and
      `/api/status.pipeline.queue`.

## Phase 3 — Health degradation thresholds

> Make the daemon pull itself out of rotation before backlog poisons
> downstream consumers.

- [ ] Add `cfg.health.queue` config block with defaults:
      - `summaryDeadWarn` = 50
      - `summaryDeadFail` = 500
      - `summaryOldestPendingWarnSec` = 300
      - `summaryOldestPendingFailSec` = 1800
      - `summaryOldestDeadWarnSec` = 86400 (1 day)
      - `extractionDeadWarn` / `extractionDeadFail` mirroring the above
- [ ] Apply thresholds in `getQueueHealth` scoring (warn → degraded,
      fail → unhealthy).
- [ ] Wire into composite score in `getDiagnostics` so a degraded
      queue pulls the overall composite below `0.8` (healthy cutoff).
- [ ] Mirror the threshold into `/health/ready` so a single config
      knob controls both the cached report and the live probe.
- [ ] Tests: with seeded fixture, assert `status` flips from healthy →
      degraded → unhealthy at the configured boundaries.

## Phase 4 — Safe repair commands with dry-run/preview

> Make repair predictable. No silent mutation, no "I clicked it and
> 1,667 rows disappeared".

### 4a. Extend `requeueDeadJobs`

- [ ] Add `dryRun` parameter to `requeueDeadJobs` in `repair-actions.ts`.
      Dry-run returns the same `RepairResult` shape with `affected = 0`
      and a `preview` field listing ids that *would* be requeued (cap
      at 100 for log size).
- [ ] Add `ids?: readonly string[]` filter so operators can target
      specific jobs (CLI: `signet repair queue requeue --ids=a,b,c`).
- [ ] Add `olderThanMs?: number` and `errorPattern?: string` filters
      for selective retry.
- [ ] Rate-limit gate stays unchanged; dry-run must bypass the gate
      but still record the dry-run in the audit history.

### 4b. New `cancelObsoleteJobs` action

- [ ] Action signature mirrors `requeueDeadJobs`:
      `cancelObsoleteJobs(accessor, cfg, ctx, limiter, options?)`
- [ ] Default target: rows where `status IN ('dead','completed')` and
      `created_at < now - olderThanMs` (default 30 days). Both
      `memory_jobs` and `summary_jobs` are supported, scoped by
      `tables?: ('memory'|'summary')[]`.
- [ ] "Cancel" = move to a new terminal status `cancelled` (new column
      via migration `prerequisite-cancel-status.ts`) **OR** soft-delete
      in a new `job_cancellations` audit table that preserves the full
      row + reason + actor. Pick the lighter schema (recommendation:
      audit table — keeps `summary_jobs` schema untouched).
- [ ] Dry-run by default for CLI; `--apply` flag required to mutate.
- [ ] Audit row written via `insertHistoryEvent` with `repairAction:
      cancelObsoleteJobs`.

### 4c. New `pruneTerminalJobs` action

- [ ] Same gate + rate-limit pattern as other actions.
- [ ] Default target: rows where `status IN ('cancelled','completed',
      'dead')` and `created_at < now - retentionMs` (default 90 days
      for `dead`, 14 for `completed`, configurable).
- [ ] Before delete, copy the row to a new `job_archive` table
      (schema: full row + `archived_at`, `archived_by`, `reason`).
      This is the "preserving provenance" requirement.
- [ ] Hard cap per call: 1000 rows. Operators run repeatedly.
- [ ] Dry-run by default; `--apply` to mutate.
- [ ] Tests: seed rows, run dry-run, assert zero mutations; run
      apply, assert archive rows match deleted originals.

### 4d. HTTP + CLI exposure

- [ ] `POST /api/diagnostics/queue/repair` with body:
      `{ action: 'requeue'|'cancel'|'prune', dryRun: bool, ids?: [],
      tables?: [], olderThanMs?: number, errorPattern?: string }`
      Permission-gated with `admin`.
- [ ] CLI:
      - `signet repair queue requeue [--ids=a,b,c] [--older-than=7d]
        [--dry-run|--apply]`
      - `signet repair queue cancel [--tables=summary,memory]
        [--older-than=30d] [--dry-run|--apply]`
      - `signet repair queue prune [--tables=summary,memory]
        [--older-than=90d] [--dry-run|--apply]`
- [ ] All CLI commands print the same `RepairResult` shape, colour-coded
      (green for apply, yellow for dry-run, red for denied).

## Phase 5 — Oldest job, last error, provider block reason

> Surface the *why*, not just the *how many*.

- [ ] Add `oldestDeadSummaryJob: { id, harness, session_key,
      created_at, attempts, error } | null` to `QueueHealth`.
- [ ] Add `lastProviderError: { at, message, provider } | null` from
      the existing `ProviderTracker`.
- [ ] Render both in `/api/diagnostics/queue`, `signet status`, and
      `/health/ready` body (under `degradedReasons`).

## Phase 6 — Regression tests

> Per PR template: "Regression tests added for each bug fix."

- [ ] `diagnostics.test.ts`: seed mixed memory + summary queues, assert
      the new `QueueCounts` breakdown.
- [ ] `repair-actions.test.ts`: assert `requeueDeadJobs` dry-run is
      side-effect-free; assert new `cancelObsoleteJobs` and
      `pruneTerminalJobs` dry-run + apply paths preserve provenance.
- [ ] `daemon-status.test.ts` and a new `pipeline-queue-routes.test.ts`:
      `/api/status`, `/health/ready`, `/api/diagnostics/queue` return
      expected payloads for healthy / degraded / unhealthy fixtures.
- [ ] End-to-end `worker.integration.test.ts`: seed 1,667 dead summary
      jobs (matching the issue's real number), assert `signet status`
      reports them and a `signet repair queue prune --older-than=30d
      --dry-run` preview matches the seeded count.

## Phase 7 — Docs & rollout

- [ ] `docs/PIPELINE.md` updated with the new surfaces and repair
      commands.
- [ ] `docs/api/diagnostics.md` documents the new endpoint and
      `/health/ready` semantics.
- [ ] `CHANGELOG.md` entry under `Unreleased` (or the next release
      line) referencing #901.
- [ ] Migration guide snippet in PR description for operators running
      pre-0.148 daemons (no schema migration needed if we go with the
      audit-table approach for cancel/prune).

## Phase 8 — Self-review & ship

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run format`
- [ ] `bun test`
- [ ] `autoreview` against the diff; address every `severity >= medium`
      finding.
- [ ] Final `autoreview` after fixes; ensure zero new findings.
- [ ] Squash into conventional commits with `Assisted-by` tags per
      `AI_POLICY.md`.
- [ ] Mark PR ready for review.

---

## Notes for the reviewer

- This plan intentionally separates **visibility** (Phases 2–3) from
  **repair** (Phase 4). Both are required to close #901 but the
  visibility work is independently shippable in a small first PR if
  the reviewer wants to slice it.
- The repair actions all reuse the existing `RepairContext`,
  `RateLimiter`, and `checkRepairGate` plumbing — no new gate policy
  is introduced.
- Thresholds default to the values quoted in `docs/PIPELINE.md` §"Job
  retention" and the existing `getQueueHealth` scoring — no surprises
  for current operators.
- The schema-light approach (audit table for cancel, archive table
  for prune) avoids a breaking migration on `summary_jobs`.
