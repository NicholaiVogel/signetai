import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDefaultBasePath(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

export function expandHome(p: string, home = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
	return p;
}

export const SCHEMA_VERSION = 3;
export const SPEC_VERSION = "1.0";
export const SCHEMA_ID = "signet/v1";

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_HYBRID_ALPHA = 0.7;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
