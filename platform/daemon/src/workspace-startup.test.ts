import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const daemonScript = join(import.meta.dir, "daemon.ts");
const tempDirs: string[] = [];

function runDaemon(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [daemonScript], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`daemon did not fail closed in time\n${output}`));
		}, 10_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon workspace startup preflight", () => {
	it("fails closed when the configured workspace is moved aside", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-startup-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		const movedWorkspace = join(root, "moved-workspace");
		const configHome = join(root, "config");
		mkdirSync(join(workspace, "memory"), { recursive: true });
		mkdirSync(join(configHome, "signet"), { recursive: true });
		writeFileSync(join(workspace, "agent.yaml"), "name: Regression\n");
		writeFileSync(join(workspace, "memory", "memories.db"), "existing database\n");
		writeFileSync(
			join(configHome, "signet", "workspace.json"),
			JSON.stringify({ version: 1, workspace, updatedAt: new Date().toISOString() }),
		);
		// Keep the established workspace intact under a different name. The
		// startup path must not recreate the configured location.
		renameSync(workspace, movedWorkspace);

		const result = await runDaemon({
			...process.env,
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: configHome,
			SIGNET_PATH: workspace,
			SIGNET_PORT: "39817",
			SIGNET_DISABLE_TELEMETRY: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
		});

		expect(result.code).toBe(1);
		expect(result.output).toContain("Signet cannot start: missing workspace");
		expect(result.output).toContain("will not recreate it");
		expect(readFileSync(join(movedWorkspace, "agent.yaml"), "utf8")).toContain("Regression");
		expect(Bun.file(workspace).exists()).resolves.toBe(false);
	});
});
