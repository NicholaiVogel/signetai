/**
 * Fast source-run boot guard for the daemon's most dangerous failure mode:
 * startup completes neither liveness nor idle. The gate deliberately runs the
 * real daemon from TypeScript, then observes the real HTTP process and its OS
 * CPU usage instead of testing an in-process mock.
 *
 * Usage:
 *   bun tests/integration/boot-wedge/run.ts [--out DIR]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	BOOT_TIMEOUT_MS,
	CPU_CEILING_PERCENT,
	CPU_INTERVAL_MS,
	LIVE_INTERVAL_MS,
	LIVE_REQUEST_TIMEOUT_MS,
	MIN_CPU_SAMPLES,
	OBSERVATION_MS,
	evaluateBootWedge,
	type BootWedgeMeasurements,
} from "./criteria";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const daemonScript = join(repoRoot, "platform/daemon/src/daemon.ts");
const outputDir = process.argv.includes("--out")
	? resolve(process.argv[process.argv.indexOf("--out") + 1] ?? "boot-wedge-artifacts")
	: null;
const outputPath = join(outputDir ?? tmpdir(), "boot-wedge.json");

interface CpuSnapshot {
	readonly processTicks: number;
	readonly totalTicks: number;
}

interface CpuSample {
	readonly at: number;
	readonly percent: number;
}

interface LiveMeasurement {
	readonly samples: number;
	readonly successes: number;
	readonly failures: number;
	readonly maxMs: number;
	readonly latenciesMs: readonly number[];
}

interface BootWedgeReport {
	readonly harness: "boot-wedge";
	readonly platform: NodeJS.Platform;
	readonly pid: number | null;
	readonly startupMs: number;
	readonly observationMs: number;
	readonly cpu: {
		readonly available: boolean;
		readonly samples: readonly CpuSample[];
		readonly maxPercent: number;
		readonly ceilingPercent: number;
	};
	readonly live: LiveMeasurement;
	readonly evaluation: ReturnType<typeof evaluateBootWedge>;
	readonly daemonStdoutTail: string;
	readonly daemonStderrTail: string;
	readonly error?: string;
}

function parseOutputDir(): void {
	if (outputDir) mkdirSync(outputDir, { recursive: true });
}

function appendBounded(target: string[], chunk: Buffer): void {
	target.push(chunk.toString("utf8"));
	const text = target.join("");
	if (text.length > 16_000) {
		target.splice(0, target.length, text.slice(-16_000));
	}
}

function reservePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("could not obtain an ephemeral loopback port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

function readCpuSnapshot(pid: number): CpuSnapshot | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closingParen = stat.lastIndexOf(")");
		if (closingParen < 0) return null;
		const fields = stat
			.slice(closingParen + 2)
			.trim()
			.split(/\s+/);
		const userTicks = Number(fields[11]);
		const systemTicks = Number(fields[12]);
		const cpuLine = readFileSync("/proc/stat", "utf8").split("\n", 1)[0] ?? "";
		const totalTicks = cpuLine
			.trim()
			.split(/\s+/)
			.slice(1)
			.reduce((sum, value) => sum + Number(value), 0);
		if (![userTicks, systemTicks, totalTicks].every(Number.isFinite)) return null;
		return { processTicks: userTicks + systemTicks, totalTicks };
	} catch {
		return null;
	}
}

function cpuPercent(previous: CpuSnapshot, current: CpuSnapshot): number | null {
	const processDelta = current.processTicks - previous.processTicks;
	const totalDelta = current.totalTicks - previous.totalTicks;
	if (processDelta < 0 || totalDelta <= 0) return null;
	return (processDelta / totalDelta) * cpus().length * 100;
}

function childIsAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function waitForLive(origin: string, child: ChildProcess): Promise<number> {
	const startedAt = Date.now();
	const deadline = startedAt + BOOT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!childIsAlive(child)) {
			throw new Error(
				`daemon exited during startup (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
			);
		}
		try {
			const response = await fetch(`${origin}/health/live`, {
				signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
			});
			if (response.status === 200) return Date.now() - startedAt;
		} catch {
			// Startup is expected to refuse connections until the listener binds.
		}
		await Bun.sleep(100);
	}
	throw new Error(`daemon did not become live within ${BOOT_TIMEOUT_MS}ms`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
	if (!child || !childIsAlive(child)) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolveStop) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolveStop();
		}, 5_000);
		child.once("close", () => {
			clearTimeout(timer);
			resolveStop();
		});
	});
}

function writeConfig(agentsDir: string): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		[
			"embedding:",
			"  provider: none",
			"memory:",
			"  pipelineV2:",
			"    enabled: true",
			"    hints:",
			"      enabled: false",
			"    reflections:",
			"      enabled: false",
			"    embeddingTracker:",
			"      enabled: false",
			"    modelRegistry:",
			"      enabled: false",
			"    procedural:",
			"      enabled: false",
			"    feedback:",
			"      enabled: false",
			"    significance:",
			"      enabled: false",
			"    telemetryEnabled: false",
			"",
		].join("\n"),
	);
}

async function run(): Promise<BootWedgeReport> {
	const workspace = mkdtempSync(join(tmpdir(), "signet-boot-wedge-"));
	const agentsDir = join(workspace, "agents");
	mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
	writeConfig(agentsDir);

	let child: ChildProcess | null = null;
	const stdout: string[] = [];
	const stderr: string[] = [];
	let startupMs = -1;
	const liveLatencies: number[] = [];
	let liveSuccesses = 0;
	let liveFailures = 0;
	const cpuSamples: CpuSample[] = [];
	let error: string | undefined;
	try {
		const port = await reservePort();
		const daemonHome = join(workspace, "home");
		mkdirSync(daemonHome, { recursive: true });
		child = spawn(process.execPath, [daemonScript], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: daemonHome,
				USERPROFILE: daemonHome,
				CODEX_HOME: join(daemonHome, ".codex"),
				CLAUDE_CONFIG_DIR: join(daemonHome, ".claude"),
				HERMES_HOME: join(daemonHome, ".hermes"),
				SIGNET_PATH: agentsDir,
				SIGNET_PORT: String(port),
				SIGNET_HOST: "127.0.0.1",
				SIGNET_BIND: "127.0.0.1",
				SIGNET_TELEMETRY_OPTOUT: "1",
				SIGNET_DAEMON_ENTRYPOINT: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.on("error", (caught) => {
			error = `daemon spawn failed: ${caught instanceof Error ? caught.message : String(caught)}`;
		});
		child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));

		const origin = `http://127.0.0.1:${port}`;
		startupMs = await waitForLive(origin, child);
		const observationStartedAt = Date.now();
		let previousCpu = readCpuSnapshot(child.pid);
		let previousCpuAt = performance.now();
		while (Date.now() - observationStartedAt < OBSERVATION_MS) {
			const liveStartedAt = performance.now();
			let status = 0;
			try {
				const response = await fetch(`${origin}/health/live`, {
					signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
				});
				status = response.status;
			} catch {
				status = 0;
			}
			liveLatencies.push(performance.now() - liveStartedAt);
			if (status === 200) liveSuccesses++;
			else liveFailures++;

			const now = performance.now();
			if (now - previousCpuAt >= CPU_INTERVAL_MS) {
				const currentCpu = readCpuSnapshot(child.pid);
				if (previousCpu && currentCpu) {
					const percent = cpuPercent(previousCpu, currentCpu);
					if (percent !== null) cpuSamples.push({ at: Date.now(), percent });
				}
				if (currentCpu) previousCpu = currentCpu;
				previousCpuAt = now;
			}
			if (status !== 200 || !childIsAlive(child)) {
				throw new Error(
					`liveness failed during observation (status=${status}, code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
				);
			}
			await Bun.sleep(LIVE_INTERVAL_MS);
		}
		if (!childIsAlive(child)) {
			throw new Error(
				`daemon exited at the end of observation (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
			);
		}
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await stopChild(child);
		rmSync(workspace, { recursive: true, force: true });
	}

	const live: LiveMeasurement = {
		samples: liveLatencies.length,
		successes: liveSuccesses,
		failures: liveFailures,
		maxMs: liveLatencies.length > 0 ? Math.max(...liveLatencies) : 0,
		latenciesMs: liveLatencies,
	};
	const measurements: BootWedgeMeasurements = {
		startupMs,
		live,
		cpu: {
			samples: cpuSamples.length,
			maxPercent: cpuSamples.length > 0 ? Math.max(...cpuSamples.map((sample) => sample.percent)) : 0,
		},
	};
	const baseEvaluation = evaluateBootWedge(measurements);
	const evaluation = error
		? {
				...baseEvaluation,
				pass: false,
				checks: [
					...baseEvaluation.checks,
					{ name: "harness completes without an error", pass: false, observed: error, limit: "no harness error" },
				],
			}
		: baseEvaluation;
	const report: BootWedgeReport = {
		harness: "boot-wedge",
		platform: process.platform,
		pid: child?.pid ?? null,
		startupMs,
		observationMs: OBSERVATION_MS,
		cpu: {
			available: process.platform === "linux" && cpuSamples.length >= MIN_CPU_SAMPLES,
			samples: cpuSamples,
			maxPercent: measurements.cpu.maxPercent,
			ceilingPercent: CPU_CEILING_PERCENT,
		},
		live,
		evaluation,
		daemonStdoutTail: stdout.join(""),
		daemonStderrTail: stderr.join(""),
		...(error ? { error } : {}),
	};
	return report;
}

if (import.meta.main) {
	parseOutputDir();
	const report = await run();
	writeFileSync(outputPath, JSON.stringify(report, null, 2));
	for (const check of report.evaluation.checks) {
		console.error(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}: ${check.observed} (limit ${check.limit})`);
	}
	console.error(`  artifact: ${outputPath}`);
	if (report.error) console.error(`  error: ${report.error}`);
	process.exitCode = report.evaluation.pass ? 0 : 1;
}
