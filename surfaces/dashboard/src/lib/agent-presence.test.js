import { afterEach, describe, expect, it } from "bun:test";
import { buildOwnAgentPresenceUrl, getOwnAgentPresence, selectLatestOwnPresence } from "./agent-presence";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("agent presence api helpers", () => {
	it("builds an own-agent readout URL scoped to the current agent", () => {
		const url = new URL(buildOwnAgentPresenceUrl("http://localhost:3850", 10, "agent-a"));

		expect(url.pathname).toBe("/api/cross-agent/presence");
		expect(url.searchParams.get("agent_id")).toBe("agent-a");
		expect(url.searchParams.get("include_self")).toBe("true");
		expect(url.searchParams.get("limit")).toBe("10");
	});

	it("filters mixed peer and self responses to the current agent", async () => {
		globalThis.fetch = /** @type {typeof fetch} */ (
			async (input) => {
				const url = new URL(String(input), "http://localhost");
				expect(url.pathname.endsWith("/api/cross-agent/presence")).toBe(true);
				expect(url.searchParams.get("agent_id")).toBe("agent-a");
				expect(url.searchParams.get("include_self")).toBe("true");
				expect(url.searchParams.get("limit")).toBe("10");
				return new Response(
					JSON.stringify({
						sessions: [
							{
								sessionKey: "peer-newer",
								agentId: "peer",
								harness: "codex",
								project: "/repo/peer",
								lastSeenAt: "2026-04-26T02:25:00.000Z",
							},
							{
								sessionKey: "default-newer",
								agentId: "default",
								harness: "claude-code",
								project: "/repo/default",
								lastSeenAt: "2026-04-26T02:24:00.000Z",
							},
							{
								sessionKey: "agent-a-session",
								agentId: "agent-a",
								harness: "claude-code",
								project: "/repo/signetai",
								lastSeenAt: "2026-04-26T02:21:36.000Z",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
		);

		const res = await getOwnAgentPresence("", 10, "agent-a");

		expect(res).toHaveLength(1);
		expect(res[0].agentId).toBe("agent-a");
		expect(res[0].project).toBe("/repo/signetai");
	});

	it("selects the latest session for only the current agent", () => {
		const selected = selectLatestOwnPresence(
			[
				{
					sessionKey: "peer-newer",
					agentId: "peer",
					harness: "codex",
					project: "/repo/peer",
					lastSeenAt: "2026-04-26T02:25:00.000Z",
				},
				{
					sessionKey: "default-newer",
					agentId: "default",
					harness: "claude-code",
					project: "/repo/default",
					lastSeenAt: "2026-04-26T02:24:00.000Z",
				},
				{
					sessionKey: "agent-a-older",
					agentId: "agent-a",
					harness: "claude-code",
					project: "/repo/old",
					lastSeenAt: "2026-04-26T02:10:00.000Z",
				},
				{
					sessionKey: "agent-a-newer",
					agentId: "agent-a",
					harness: "claude-code",
					project: "/repo/signetai",
					lastSeenAt: "2026-04-26T02:21:36.000Z",
				},
			],
			"agent-a",
		);

		expect(selected?.sessionKey).toBe("agent-a-newer");
		expect(selected?.project).toBe("/repo/signetai");
	});

	it("falls back to no sessions when presence cannot be fetched", async () => {
		globalThis.fetch = /** @type {typeof fetch} */ (
			/** @type {unknown} */ (async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 }))
		);

		const res = await getOwnAgentPresence("", 10, "agent-a");

		expect(res).toEqual([]);
	});
});
