import { describe, expect, it } from "bun:test";
import { buildHooksFile } from "./index";

describe("Codex cross-agent notification hooks", () => {
	it("installs a trusted PreToolUse notification command", () => {
		const file = buildHooksFile(["signet"], null) as {
			hooks?: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
		};
		const handler = file.hooks?.PreToolUse?.[0]?.hooks[0];
		expect(handler?.command).toContain("hook notifications -H codex --hook PreToolUse --codex-json");
		expect(handler?.timeout).toBe(5);
	});
});
