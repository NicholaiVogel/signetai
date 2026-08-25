import { spawn } from "node:child_process";

async function main(): Promise<void> {
	const childPath = process.env.SIGNET_TRANSCRIPT_RECOVERY_CHILD_PATH;
	if (childPath === undefined) throw new Error("Transcript recovery supervisor child path is missing");

	const child = spawn(process.execPath, [childPath], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	if (child.pid !== undefined) process.stdout.write(`${JSON.stringify({ type: "started", pid: child.pid })}\n`);
	const forward = (signal: NodeJS.Signals): void => {
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch {
				// The child may have exited between the check and the signal.
			}
		}
		child.kill(signal);
	};
	process.once("SIGTERM", () => forward("SIGTERM"));
	process.once("SIGINT", () => forward("SIGINT"));

	const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
	});
	if (signal !== null || code !== 0) process.exitCode = code ?? 1;
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
