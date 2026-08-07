import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, resolveLoggerConfig } from "./logger";

describe("logger config", () => {
	it("uses SIGNET_PATH for the default daemon log directory", () => {
		expect(resolveLoggerConfig({ SIGNET_PATH: "/tmp/signet-workspace" }, "/home/test")).toEqual({
			logDir: join("/tmp/signet-workspace", ".daemon", "logs"),
		});
	});

	it("keeps explicit log file and log directory overrides ahead of SIGNET_PATH", () => {
		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_FILE: "/tmp/signet.log",
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logFilePath: "/tmp/signet.log", logDir: "/tmp" });

		expect(
			resolveLoggerConfig(
				{
					SIGNET_LOG_DIR: "/tmp/logs",
					SIGNET_PATH: "/tmp/signet-workspace",
				},
				"/home/test",
			),
		).toEqual({ logDir: "/tmp/logs" });
	});

	it("falls back to the home-scoped agents directory", () => {
		expect(resolveLoggerConfig({}, "/home/test")).toEqual({
			logDir: join("/home/test", ".agents", ".daemon", "logs"),
		});
	});
});

// Regression for issue #1148: the daemon exit path calls logger.shutdown()
// before process.exit(); without that explicit flush, the final log lines
// ("Received SIGTERM; shutting down") can sit in the 1s-flush buffer and be
// lost on exit, which is exactly the "vanished with no shutdown log" symptom.
describe("logger shutdown flush", () => {
	it("writes buffered entries to the log file on shutdown", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-logger-"));
		try {
			const log = new Logger({
				logDir: root,
				consoleOutput: false,
				jsonFormat: false,
				level: "info",
			});
			log.info("daemon", "Received signal:SIGTERM; shutting down");
			// No 1s timer flush has run yet (the test is sub-second); shutdown()
			// must flush the buffer synchronously.
			log.shutdown();
			const today = new Date().toISOString().split("T")[0];
			const content = readFileSync(join(root, `signet-${today}.log`), "utf-8");
			expect(content).toContain("Received signal:SIGTERM; shutting down");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
