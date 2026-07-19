/**
 * Cross-platform native build script.
 * Checks for cargo availability before attempting to build the Rust native module.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const nativeDir = join(import.meta.dir, "..", "platform", "native");

if (!existsSync(nativeDir)) {
	console.log("[signet] platform/native not found, skipping native build");
	process.exit(0);
}

// Check if cargo is available
try {
	const locator = process.platform === "win32" ? "where" : "which";
	execSync(`${locator} cargo`, { stdio: "ignore", windowsHide: true });
} catch {
	console.log("[signet] skipping native build (rust not installed)");
	process.exit(0);
}

// Build the native module
try {
	execSync("bun run build", { cwd: nativeDir, stdio: "inherit" });
} catch {
	console.log("[signet] native build failed (optional - continuing without native accelerators)");
	process.exit(0);
}
