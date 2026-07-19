// Lint-staged config for the signet monorepo root.
// Each workspace package has its own package.json which lint-staged would
// otherwise try (and fail) to load — so we pin the config here.

/** @type {import('lint-staged').Config} */
const config = {
	"*.{js,jsx,ts,tsx,json,jsonc}": ["biome check --write --no-errors-on-unmatched"],
	"*.rs": ["cd platform/daemon-rs && cargo fmt --"],
};

export default config;