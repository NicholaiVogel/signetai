-- Issue #902 — session lifecycle outcome audit table (parity with TS 088).
--
-- TTL expiry of a tracked session is a formal lifecycle transition: every
-- transition writes one audit row here recording whether finalization ran
-- (checkpoint + summary enqueue) or was intentionally skipped (with the
-- skip reason). Modeled on the job_cancellations audit pattern.

CREATE TABLE IF NOT EXISTS session_outcomes (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    session_id TEXT,
    agent_id TEXT,
    outcome TEXT NOT NULL,
    reason TEXT NOT NULL,
    skip_reason TEXT,
    checkpoint_id TEXT,
    summary_job_id TEXT,
    payload_json TEXT,
    actor TEXT NOT NULL DEFAULT 'daemon',
    actor_type TEXT NOT NULL DEFAULT 'daemon',
    request_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_outcomes_key_reason
    ON session_outcomes(session_key, reason);

CREATE INDEX IF NOT EXISTS idx_session_outcomes_outcome_created
    ON session_outcomes(outcome, created_at);
