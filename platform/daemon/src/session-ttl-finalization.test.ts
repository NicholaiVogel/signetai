/**
 * Regression tests for issue #902 — session TTL eviction must be a formal,
 * auditable lifecycle transition: checkpoint persisted before eviction,
 * idempotent policy-gated finalization, explicit skip reasons, and a
 * session_outcomes audit row for every transition.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { getSessionHealth } from "./diagnostics";
import {
	claimSession,
	hasSession,
	resetSessions,
	runStaleCleanup,
	setSessionExpirationHandler,
	type SessionExpiredInfo,
} from "./session-tracker";
import { finalizeExpiredSession, registerSessionTtlFinalization } from "./session-ttl-finalization";

const AGENT = "default";
const LONG_TRANSCRIPT = `user: please investigate the flaky test\nassistant: root cause is a race in the scheduler\n`.repeat(
	20,
);
const SHORT_TRANSCRIPT = "user: hi\nassistant: hello";

let dir: string;

function seedTranscript(sessionKey: string, content: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_transcripts (session_key, agent_id, harness, project, content, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(sessionKey, AGENT, "claude-code", "/Users/test/project", content, new Date().toISOString());
	});
}

function outcomeRows(sessionKey: string): Array<Record<string, unknown>> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare("SELECT * FROM session_outcomes WHERE session_key = ? ORDER BY created_at")
				.all(sessionKey) as Array<Record<string, unknown>>,
	);
}

function checkpointRows(sessionKey: string): Array<Record<string, unknown>> {
	return getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare("SELECT * FROM session_checkpoints WHERE session_key = ? ORDER BY created_at")
				.all(sessionKey) as Array<Record<string, unknown>>,
	);
}

function summaryJobRows(sessionKey: string): Array<Record<string, unknown>> {
	return getDbAccessor().withReadDb(
		(db) =>
			db.prepare("SELECT * FROM summary_jobs WHERE session_key = ? ORDER BY created_at").all(sessionKey) as Array<
				Record<string, unknown>
			>,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-ttl-"));
	process.env.SIGNET_PATH = dir;
	resetSessions();
	try {
		closeDbAccessor();
	} catch {}
	initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
});

afterEach(() => {
	resetSessions();
	try {
		closeDbAccessor();
	} catch {}
	rmSync(dir, { recursive: true, force: true });
});

describe("session-tracker TTL eviction hook", () => {
	test("stale sweep invokes the expiration handler before eviction", () => {
		const seen: SessionExpiredInfo[] = [];
		setSessionExpirationHandler((info) => seen.push(info));
		claimSession("sess-a", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();
		expect(seen.length).toBe(1);
		expect(seen[0]?.key).toBe("sess-a");
		expect(seen[0]?.runtimePath).toBe("plugin");
		expect(seen[0]?.agentId).toBe(AGENT);
		expect(hasSession("sess-a")).toBe(false);
	});

	test("handler failure does not block eviction", () => {
		setSessionExpirationHandler(() => {
			throw new Error("boom");
		});
		claimSession("sess-b", "legacy", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();
		expect(hasSession("sess-b")).toBe(false);
	});

	test("opportunistic stale eviction (hasSession) also transitions", () => {
		const seen: SessionExpiredInfo[] = [];
		setSessionExpirationHandler((info) => seen.push(info));
		claimSession("sess-c", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		expect(hasSession("sess-c")).toBe(false);
		expect(seen.length).toBe(1);
	});

	test("live sessions are not transitioned", () => {
		const seen: SessionExpiredInfo[] = [];
		setSessionExpirationHandler((info) => seen.push(info));
		claimSession("sess-d", "plugin", AGENT);
		runStaleCleanup();
		expect(seen.length).toBe(0);
		expect(hasSession("sess-d")).toBe(true);
	});
});

describe("session TTL finalization (issue #902)", () => {
	test("expired session with transcript activity checkpoints, enqueues, and audits", () => {
		seedTranscript("sess-full", LONG_TRANSCRIPT);
		registerSessionTtlFinalization();
		claimSession("sess-full", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();

		const checkpoints = checkpointRows("sess-full");
		expect(checkpoints.length).toBe(1);
		expect(checkpoints[0]?.trigger).toBe("ttl_expired");

		const jobs = summaryJobRows("sess-full");
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.boundary_reason).toBe("ttl_expired");
		expect(jobs[0]?.status).toBe("pending");

		const outcomes = outcomeRows("sess-full");
		expect(outcomes.length).toBe(1);
		expect(outcomes[0]?.outcome).toBe("finalized");
		expect(outcomes[0]?.reason).toBe("ttl_expired");
		expect(outcomes[0]?.summary_job_id).toBe(jobs[0]?.id);
		expect(outcomes[0]?.checkpoint_id).toBe(checkpoints[0]?.id);
	});

	test("re-finalization is idempotent", () => {
		seedTranscript("sess-idem", LONG_TRANSCRIPT);
		const info: SessionExpiredInfo = {
			key: "sess-idem",
			agentId: AGENT,
			runtimePath: "plugin",
			claimedAt: new Date().toISOString(),
		};
		const first = finalizeExpiredSession(info);
		expect(first.outcome).toBe("finalized");
		const second = finalizeExpiredSession(info);
		expect(second.outcome).toBe("already-recorded");
		expect(outcomeRows("sess-idem").length).toBe(1);
		expect(summaryJobRows("sess-idem").length).toBe(1);
		expect(checkpointRows("sess-idem").length).toBe(1);
	});

	test("short transcript records an intentional skip, still checkpoints", () => {
		seedTranscript("sess-short", SHORT_TRANSCRIPT);
		registerSessionTtlFinalization();
		claimSession("sess-short", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();

		expect(checkpointRows("sess-short").length).toBe(1);
		expect(summaryJobRows("sess-short").length).toBe(0);
		const outcomes = outcomeRows("sess-short");
		expect(outcomes.length).toBe(1);
		expect(outcomes[0]?.outcome).toBe("skipped");
		expect(outcomes[0]?.skip_reason).toBe("transcript-too-short");
	});

	test("missing transcript records a no-transcript skip without checkpoint", () => {
		registerSessionTtlFinalization();
		claimSession("sess-empty", "legacy", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();

		expect(checkpointRows("sess-empty").length).toBe(0);
		expect(summaryJobRows("sess-empty").length).toBe(0);
		const outcomes = outcomeRows("sess-empty");
		expect(outcomes.length).toBe(1);
		expect(outcomes[0]?.outcome).toBe("skipped");
		expect(outcomes[0]?.skip_reason).toBe("no-transcript");
	});

	test("diagnostics expose expired/unfinalized session counts", () => {
		seedTranscript("sess-diag-full", LONG_TRANSCRIPT);
		seedTranscript("sess-diag-skip", SHORT_TRANSCRIPT);
		registerSessionTtlFinalization();
		claimSession("sess-diag-full", "plugin", AGENT, { ttlMs: 1 });
		claimSession("sess-diag-skip", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();

		const health = getDbAccessor().withReadDb((db) => getSessionHealth(db, 0));
		expect(health.expired).toBe(2);
		expect(health.unfinalized).toBe(1);
	});

	test("synthesis disabled records pipeline-disabled skip", () => {
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  pipelineV2:\n    enabled: false\n");
		seedTranscript("sess-disabled", LONG_TRANSCRIPT);
		registerSessionTtlFinalization();
		claimSession("sess-disabled", "plugin", AGENT, { ttlMs: 1 });
		Bun.sleepSync(5);
		runStaleCleanup();

		expect(checkpointRows("sess-disabled").length).toBe(1);
		expect(summaryJobRows("sess-disabled").length).toBe(0);
		const outcomes = outcomeRows("sess-disabled");
		expect(outcomes.length).toBe(1);
		expect(outcomes[0]?.outcome).toBe("skipped");
		expect(outcomes[0]?.skip_reason).toBe("pipeline-disabled");
	});
});
