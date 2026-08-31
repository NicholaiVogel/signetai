import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDirs: string[] = [];
const sentinel = "compiled setup OAuth reached login method prompt";

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("compiled setup OAuth path", () => {
	test("loads OpenAI Codex OAuth through the interactive setup login boundary", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-compiled-setup-oauth-"));
		tempDirs.push(directory);
		const fixture = join(directory, "setup-oauth-smoke.ts");
		const binary = join(directory, process.platform === "win32" ? "setup-oauth-smoke.exe" : "setup-oauth-smoke");
		const setupConnect = join(root, "surfaces", "cli", "src", "features", "setup-connect.ts");
		writeFileSync(
			fixture,
			`import { runOAuthLogin } from ${JSON.stringify(setupConnect)};

const ui = {
  openUrl: () => {},
  showDeviceCode: () => {},
  promptText: async () => "",
  promptSelect: async () => {
    process.stdout.write("${sentinel}\\n");
    throw new Error("${sentinel}");
  },
};

try {
  await runOAuthLogin(ui, "openai-codex");
  process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "${sentinel}") process.exitCode = 0;
  else {
    process.stderr.write(message + "\\n");
    process.exitCode = 1;
  }
}
`,
		);
		const build = spawnSync(process.execPath, ["build", "--compile", "--target=bun", "--outfile", binary, fixture], {
			cwd: root,
			encoding: "utf8",
		});
		expect(build.status, `${build.stdout ?? ""}${build.stderr ?? ""}`).toBe(0);
		if (build.status !== 0) return;
		if (process.platform !== "win32") chmodSync(binary, 0o755);

		const run = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		expect(run.status, output).toBe(0);
		expect(output).toContain(sentinel);
		expect(output).not.toContain("Cannot find module");
	});
});
