import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { createDreamingAcpxMcpConfig } from "./acpx-dreaming-mcp";

describe("Dreaming ACPX MCP config", () => {
	const configs: Array<ReturnType<typeof createDreamingAcpxMcpConfig>> = [];

	afterEach(() => {
		for (const config of configs.splice(0)) config.dispose();
	});

	it("creates one ephemeral scoped MCP server and removes it after the turn", () => {
		const config = createDreamingAcpxMcpConfig({
			agentId: "agent-a",
			passId: "pass-a",
			daemonUrl: "http://127.0.0.1:3850",
			authorizationToken: "scoped-token",
		});
		configs.push(config);
		const parsed = JSON.parse(readFileSync(config.path, "utf8")) as {
			mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }>;
		};
		expect(parsed.mcpServers).toHaveLength(1);
		expect(parsed.mcpServers[0]).toMatchObject({ name: "signet_dreaming" });
		expect(parsed.mcpServers[0]?.env).toEqual(
			expect.arrayContaining([
				{ name: "SIGNET_DREAMING_AGENT_ID", value: "agent-a" },
				{ name: "SIGNET_DREAMING_PASS_ID", value: "pass-a" },
				{ name: "SIGNET_DAEMON_URL", value: "http://127.0.0.1:3850" },
				{ name: "SIGNET_TOKEN", value: "scoped-token" },
			]),
		);
		config.dispose();
		expect(existsSync(config.path)).toBe(false);
	});
});
