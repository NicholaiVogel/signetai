//! Session TTL finalization (issue #902) — parity with the TS daemon's
//! `session-ttl-finalization.ts`.
//!
//! TTL expiry of a tracked session is a formal, auditable lifecycle
//! transition. Before the tracker evicts a stale claim, this module:
//!
//! 1. persists a final transcript checkpoint (`trigger: "ttl_expired"`),
//! 2. enqueues an idempotent summary job (`boundary_reason: "ttl_expired"`,
//!    content-derived session id) when pipeline policy allows, and
//! 3. writes a `session_outcomes` audit row recording the transition —
//!    including the explicit skip reason when finalization is intentionally
//!    not performed (pipeline disabled, transcript too short, noise session,
//!    duplicate job, or no stored transcript).
//!
//! Re-finalization for the same session key is a no-op: the audit row is the
//! idempotency guard.

use std::sync::Arc;

use rusqlite::{Connection, params};
use tracing::{info, warn};

use signet_core::db::Priority;
use signet_pipeline::memory_lineage::is_noise_session;
use signet_services::session::{ContinuitySnapshot, SessionExpiredInfo};

use crate::routes::hooks::{
    derive_reset_recovery_session_id, enqueue_summary_job, pipeline_enabled,
};
use crate::state::AppState;

const MIN_TRANSCRIPT_CHARS: usize = 500;
const TTL_REASON: &str = "ttl_expired";

/// Result of a TTL-expiry transition. Mirrors TS `SessionOutcomeRecord`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionOutcomeRecord {
    pub outcome: String, // "finalized" | "skipped" | "already-recorded"
    pub skip_reason: Option<String>,
    pub checkpoint_id: Option<String>,
    pub summary_job_id: Option<String>,
}

impl SessionOutcomeRecord {
    fn skipped(skip_reason: &str, checkpoint_id: Option<String>) -> Self {
        Self {
            outcome: "skipped".to_string(),
            skip_reason: Some(skip_reason.to_string()),
            checkpoint_id,
            summary_job_id: None,
        }
    }
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |_| Ok(()),
    )
    .is_ok()
}

/// Idempotency guard: an existing outcome row for (session_key, agent_id,
/// reason='ttl_expired') means the transition was already recorded.
fn existing_outcome(conn: &Connection, session_key: &str, agent_id: &str) -> bool {
    if !table_exists(conn, "session_outcomes") {
        return false;
    }
    conn.query_row(
        "SELECT id FROM session_outcomes
         WHERE session_key = ?1 AND agent_id = ?2 AND reason = ?3
         LIMIT 1",
        params![session_key, agent_id, TTL_REASON],
        |_| Ok(()),
    )
    .is_ok()
}

fn summary_job_exists(conn: &Connection, session_id: &str, agent_id: &str) -> bool {
    conn.query_row(
        "SELECT id FROM summary_jobs
         WHERE session_id = ?1 AND agent_id = ?2 AND status <> 'dead'
         LIMIT 1",
        params![session_id, agent_id],
        |_| Ok(()),
    )
    .is_ok()
}

fn summary_jobs_has_boundary_reason(conn: &Connection) -> bool {
    conn.prepare("PRAGMA table_info(summary_jobs)")
        .and_then(|mut stmt| {
            let names = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            Ok(names.iter().any(|n| n == "boundary_reason"))
        })
        .unwrap_or(false)
}

/// Write the audit row. Re-checks the idempotency guard inside the write so a
/// concurrent or repeated transition cannot produce a second row.
fn write_outcome_row(
    conn: &Connection,
    info: &SessionExpiredInfo,
    record: &SessionOutcomeRecord,
    session_id: Option<&str>,
) -> rusqlite::Result<()> {
    if !table_exists(conn, "session_outcomes") || existing_outcome(conn, &info.key, &info.agent_id)
    {
        return Ok(());
    }
    let payload = serde_json::json!({
        "runtimePath": info.runtime_path.as_str(),
        "claimedAt": info.claimed_at,
    });
    conn.execute(
        "INSERT INTO session_outcomes
         (id, session_key, session_id, agent_id, outcome, reason, skip_reason,
          checkpoint_id, summary_job_id, payload_json, actor, actor_type, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'daemon', 'daemon', NULL, ?11)",
        params![
            uuid::Uuid::new_v4().to_string(),
            info.key,
            session_id,
            info.agent_id,
            record.outcome,
            TTL_REASON,
            record.skip_reason,
            record.checkpoint_id,
            record.summary_job_id,
            payload.to_string(),
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

/// Run the auditable TTL-expiry transition for one evicted session claim.
/// Never fails loudly — errors are logged so tracker eviction is never
/// blocked (mirrors TS `finalizeExpiredSession`).
pub async fn finalize_expired_session(
    state: &Arc<AppState>,
    info: SessionExpiredInfo,
) -> SessionOutcomeRecord {
    match finalize_expired_session_inner(state, &info).await {
        Ok(record) => record,
        Err(error) => {
            warn!(
                error = %error,
                session_key = %info.key,
                "session-ttl: TTL finalization failed"
            );
            SessionOutcomeRecord::skipped("no-transcript", None)
        }
    }
}

async fn finalize_expired_session_inner(
    state: &Arc<AppState>,
    info: &SessionExpiredInfo,
) -> Result<SessionOutcomeRecord, signet_core::error::CoreError> {
    // Pipeline gate mirrors the Rust summary worker: the manifest exposes
    // only pipelineV2, so the TS `dreaming.enabled` alternative does not
    // apply here (see hooks::pipeline_enabled).
    let pipeline_on = pipeline_enabled(state.as_ref());
    let info = info.clone();
    let value = state
        .pool
        .write(Priority::High, move |conn| {
            let record = finalize_with_conn(conn, &info, pipeline_on)?;
            Ok(serde_json::to_value(record).unwrap_or(serde_json::Value::Null))
        })
        .await?;
    Ok(serde_json::from_value(value).unwrap_or(SessionOutcomeRecord {
        outcome: "skipped".to_string(),
        skip_reason: Some("no-transcript".to_string()),
        checkpoint_id: None,
        summary_job_id: None,
    }))
}

fn finalize_with_conn(
    conn: &Connection,
    info: &SessionExpiredInfo,
    pipeline_on: bool,
) -> Result<SessionOutcomeRecord, signet_core::error::CoreError> {
    // Idempotency: this transition may already be recorded (overlapping
    // sweep + opportunistic eviction, or a daemon restart mid-sweep).
    if existing_outcome(conn, &info.key, &info.agent_id) {
        return Ok(SessionOutcomeRecord {
            outcome: "already-recorded".to_string(),
            skip_reason: None,
            checkpoint_id: None,
            summary_job_id: None,
        });
    }

    // Stored transcript + metadata (harness/project) for this session.
    let stored: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT content, harness, project FROM session_transcripts
             WHERE session_key = ?1 AND agent_id = ?2 LIMIT 1",
            params![info.key, info.agent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    let (transcript, harness, project) = match stored {
        Some((content, harness, project)) => {
            (content.trim().to_string(), harness, project)
        }
        None => (String::new(), None, None),
    };
    let harness = harness.filter(|h| !h.trim().is_empty());
    let harness_value = harness.unwrap_or_else(|| "unknown".to_string());
    let session_id = if transcript.is_empty() {
        None
    } else {
        Some(derive_reset_recovery_session_id(&info.key, &transcript))
    };

    if transcript.is_empty() {
        let record = SessionOutcomeRecord::skipped("no-transcript", None);
        write_outcome_row(conn, info, &record, None)?;
        info!(
            session_key = %info.key,
            reason = "no-transcript",
            "session-ttl: TTL finalization skipped"
        );
        return Ok(record);
    }

    // Persist the latest checkpoint before any further transition so the
    // session is recoverable even if later steps fail.
    let snapshot = ContinuitySnapshot {
        session_key: info.key.clone(),
        harness: harness_value.clone(),
        project: project.clone(),
        project_normalized: project.clone(),
        prompt_count: 0,
        total_prompt_count: 0,
        queries: Vec::new(),
        remembers: Vec::new(),
        snippets: Vec::new(),
        duration_secs: 0,
        structural: None,
    };
    let digest = format!(
        "Session expired via TTL without a session-end event; lifecycle transition recorded ({} path).",
        info.runtime_path.as_str()
    );
    let checkpoint_id = signet_services::session::insert_checkpoint(
        conn,
        &snapshot,
        TTL_REASON,
        &digest,
    )?;

    let skip_reason: Option<&'static str> = if !pipeline_on {
        Some("pipeline-disabled")
    } else if transcript.len() < MIN_TRANSCRIPT_CHARS {
        Some("transcript-too-short")
    } else if is_noise_session(
        project.as_deref(),
        session_id.as_deref(),
        Some(info.key.as_str()),
        Some(harness_value.as_str()),
    ) {
        Some("noise-session")
    } else {
        None
    };

    if let Some(skip_reason) = skip_reason {
        let record = SessionOutcomeRecord::skipped(skip_reason, Some(checkpoint_id));
        write_outcome_row(conn, info, &record, session_id.as_deref())?;
        info!(
            session_key = %info.key,
            reason = skip_reason,
            transcript_chars = transcript.len(),
            "session-ttl: TTL finalization skipped"
        );
        return Ok(record);
    }

    let session_id = session_id.expect("session_id present when transcript is non-empty");
    if summary_job_exists(conn, &session_id, &info.agent_id) {
        let record = SessionOutcomeRecord::skipped("duplicate-job", Some(checkpoint_id));
        write_outcome_row(conn, info, &record, Some(&session_id))?;
        info!(
            session_key = %info.key,
            reason = "duplicate-job",
            "session-ttl: TTL finalization skipped"
        );
        return Ok(record);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let summary_job_id = enqueue_summary_job(
        conn,
        &harness_value,
        &transcript,
        Some(&info.key),
        &session_id,
        project.as_deref(),
        &info.agent_id,
        TTL_REASON,
        &now,
        None,
        Some(&now),
        false,
    )?;
    // boundary_reason is best-effort: the column is added by the TS-087 parity
    // migration but may be absent on hand-built test schemas.
    if summary_jobs_has_boundary_reason(conn) {
        let _ = conn.execute(
            "UPDATE summary_jobs SET boundary_reason = ?1 WHERE id = ?2",
            params![TTL_REASON, summary_job_id],
        );
    }

    let record = SessionOutcomeRecord {
        outcome: "finalized".to_string(),
        skip_reason: None,
        checkpoint_id: Some(checkpoint_id),
        summary_job_id: Some(summary_job_id),
    };
    write_outcome_row(conn, info, &record, Some(&session_id))?;
    info!(
        session_key = %info.key,
        checkpoint_id = record.checkpoint_id.as_deref().unwrap_or(""),
        summary_job_id = record.summary_job_id.as_deref().unwrap_or(""),
        transcript_chars = transcript.len(),
        "session-ttl: session TTL expiry finalized"
    );
    Ok(record)
}

/// Wire the tracker eviction hook to TTL finalization (daemon startup).
/// Mirrors TS `registerSessionTtlFinalization`. The tracker handler is sync,
/// so the DB transition is spawned onto the runtime; the idempotency guard
/// in `finalize_expired_session` makes overlapping spawns safe.
pub fn register_session_ttl_finalization(state: &Arc<AppState>) {
    let handler_state = Arc::clone(state);
    state.sessions.set_expiration_handler(move |info| {
        let state = Arc::clone(&handler_state);
        tokio::spawn(async move {
            finalize_expired_session(&state, info).await;
        });
    });
}

/// Periodic stale-claim sweep, mirroring TS `startSessionCleanup`
/// (CLEANUP_INTERVAL_MS = 15 minutes). Eviction routes through the
/// expiration handler registered above, so every expired claim is finalized.
pub async fn run_session_cleanup_loop(state: Arc<AppState>) {
    let mut interval =
        tokio::time::interval(std::time::Duration::from_millis(15 * 60 * 1000));
    // First tick completes immediately; skip it so the first sweep happens
    // after one full interval, matching the TS setInterval behavior.
    interval.tick().await;
    loop {
        interval.tick().await;
        let evicted = state.sessions.cleanup();
        if evicted > 0 {
            info!(evicted, "session-ttl: periodic sweep evicted stale sessions");
        }
    }
}
