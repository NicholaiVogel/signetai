# Integration Tests

## LLM Pipeline Tests

`tests/integration/pipeline-llm.test.ts`

Validates that local LLM prompts (targeting qwen3:4b via Ollama) produce
structurally valid and semantically reasonable output across every pipeline
stage: extraction, decision, summary, and contradiction detection.

### Requirements

- Ollama running locally on port 11434
- qwen3:4b model pulled (`ollama pull qwen3:4b`)

### Running

```bash
bun test ./tests/integration/pipeline-llm.test.ts
```

Note: these tests are NOT discovered by the default `bun test` command
because `bunfig.toml` scopes test discovery to `platform/, surfaces/, integrations/, libs/, dist/, and web/`. Run them
with an explicit `./` path prefix.

## Issue Reproductions

Issue-specific integration reproductions live under `tests/integration/repros/`.
The #1059 sustained-ingestion reproduction can be evaluated with:

```bash
bun test ./tests/integration/repros/1059/repro-1059-eval.test.ts
bun run ./tests/integration/repros/1059/repro-1059-harness.ts
```

### Design

- **Non-deterministic**: Each LLM prompt runs 3 times with statistical
  assertions (at least 2/3 must produce valid output).
- **Graceful skip**: If Ollama is unavailable, the suite skips with a
  message instead of failing.
- **Performance tracking**: Response times are logged for each test.
- **Schema compliance tests**: Parsing and validation logic is also
  tested without LLM calls (pure unit tests).

### Key Insight: JSON Mode

The tests use Ollama's `format: "json"` and `think: false` options.
Without these, qwen3:4b generates massive chain-of-thought preambles
(100+ seconds per call). With them, responses drop to 0.5-9 seconds.

The production pipeline does NOT use `format: "json"` -- it strips
`<think>` blocks and uses balanced-brace extraction post-hoc. This
means a prompt regression that breaks JSON output could pass these
tests but fail in production. Future work: add a test mode that
exercises the production path (no JSON mode, with think block stripping).

### Fixtures

`tests/integration/fixtures/transcripts.ts` contains realistic sample
conversation transcripts at varying sizes (small, medium, large) plus
edge cases (unicode-heavy, minimal).

### Typical Performance (qwen3:4b, JSON mode, desktop hardware)

| Stage | Avg Response Time |
|-------|------------------|
| Extraction (small) | ~3s |
| Extraction (medium/large) | ~8s |
| Decision | ~0.6s |
| Summary | ~3-8s |
| Contradiction | ~0.6s |

## Phase D Stability Acceptance (#1543)

`tests/integration/acceptance/` boots the real daemon from source against a
deterministic production-shaped database (~106k memories, ~11k transcript
jobs, telemetry, source index — full scale) and judges daemon stability:

- an event-loop occupancy probe is preloaded INTO the daemon process
  (`bun --preload tests/integration/acceptance/loop-probe.ts`) and samples
  per-second max event-loop delay via `perf_hooks.monitorEventLoopDelay`;
- the embedding provider is intentionally dead (refused connections) while a
  synthetic source root keeps source sync walking — the #1671 trigger shape;
- concurrent pollers hit `/health/live` (250ms), `/api/status` (2s), and
  `/api/diagnostics` (5s) while a foreground write load flows through the
  normal remember path;
- acceptance criteria (#1543): zero event-loop blocks >= 2000ms,
  `/health/live` p95 < 500ms, `/api/status` p95 < 1000ms.

The harness is a judge, not a fixer: if it fails on current main, that is the
harness working — the numbers are the baseline.

### Running

```bash
bun tests/integration/acceptance/run.ts --scale full   # full deployment profile
bun tests/integration/acceptance/run.ts --scale smoke  # smaller db, 90s run
bun tests/integration/acceptance/run.ts --scale smoke --keep  # keep workspace for inspection
```

Output: a human summary on stderr plus a machine-readable JSON artifact
(`phase-d-acceptance-<scale>.json`) with per-metric percentiles, failures,
probe samples, and the daemon log path. CI runs the smoke variant on
PRs/main (`.github/workflows/phase-d-acceptance.yml`) and the full variant
nightly.
