import type { EmbeddingConfig } from "./memory-config";

/** The semantic role determines the model's documented retrieval formatting. */
export type EmbeddingRole = "document" | "query";

export interface EmbeddingProfile {
	readonly id: string;
	readonly dimensions: number;
	readonly format: (text: string, role: EmbeddingRole) => string;
}

const QWEN_RETRIEVAL_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

const identityProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: `custom:${cfg.provider}:${cfg.model}`,
	dimensions: cfg.dimensions,
	format: (text) => text,
});

const nomicProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: "nomic-embed-text-v1.5",
	dimensions: cfg.dimensions,
	format: (text, role) => `${role === "query" ? "search_query" : "search_document"}: ${text}`,
});

const qwenProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: "qwen3-embedding",
	dimensions: cfg.dimensions,
	format: (text, role) => (role === "query" ? `Instruct: ${QWEN_RETRIEVAL_INSTRUCTION}\nQuery: ${text}` : text),
});

/**
 * Resolve only formats that the daemon can prove from the configured model.
 * Unknown models remain identity-formatted rather than receiving an invented
 * prefix that could silently harm recall.
 */
export function resolveEmbeddingProfile(cfg: EmbeddingConfig): EmbeddingProfile {
	if (!cfg.profile || cfg.profile === "legacy-raw") return identityProfile(cfg);
	const model = cfg.model.trim().toLowerCase();
	if (cfg.profile === "nomic-embed-text-v1.5" && model.includes("nomic-embed-text")) return nomicProfile(cfg);
	if (cfg.profile === "qwen3-embedding" && model.includes("qwen3-embedding")) return qwenProfile(cfg);
	return identityProfile(cfg);
}

/** The profile a new generation should use for a known configured model. */
export function recommendedEmbeddingProfileId(cfg: EmbeddingConfig): string | undefined {
	const model = cfg.model.trim().toLowerCase();
	if (model.includes("nomic-embed-text")) return "nomic-embed-text-v1.5";
	if (model.includes("qwen3-embedding")) return "qwen3-embedding";
	return undefined;
}

export function formatEmbeddingInput(text: string, cfg: EmbeddingConfig, role: EmbeddingRole): string {
	return resolveEmbeddingProfile(cfg).format(text, role);
}

/**
 * Stable, secret-free identity for a vector space. A change means existing
 * vectors cannot be queried with new query embeddings and must be rebuilt.
 *
 * The transport endpoint is deliberately excluded: two endpoints serving the
 * same provider/model/format produce the same vector space. Endpoint changes
 * affect where requests go, not whether durable vectors remain compatible.
 */
export function embeddingProfileFingerprint(cfg: EmbeddingConfig): string {
	const profile = resolveEmbeddingProfile(cfg);
	return JSON.stringify({
		profile: profile.id,
		provider: cfg.provider,
		model: cfg.model,
		dimensions: profile.dimensions,
	});
}

/**
 * Compare current fingerprints with databases written before endpoint-neutral
 * fingerprints existed. Old rows contain `baseUrl`; normalizing both shapes
 * makes that compatibility shim explicit and one-way.
 */
export function embeddingProfileFingerprintsEqual(left: string, right: string): boolean {
	try {
		const a = JSON.parse(left) as Record<string, unknown>;
		const b = JSON.parse(right) as Record<string, unknown>;
		const normalize = (value: Record<string, unknown>): string =>
			JSON.stringify({
				profile: value.profile,
				provider: value.provider,
				model: value.model,
				dimensions: value.dimensions,
			});
		return normalize(a) === normalize(b);
	} catch {
		return left === right;
	}
}
