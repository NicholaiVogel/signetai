import { describe, expect, it } from "bun:test";
import { DEFAULT_EMBEDDING_COST_RATES, calculateEmbeddingCost, resolveEmbeddingCostProvider } from "./embedding-cost";

describe("embedding cost attribution", () => {
	it("uses configured rates and identifies OpenRouter by endpoint", () => {
		expect(resolveEmbeddingCostProvider("openai", "https://openrouter.ai/api/v1")).toBe("openrouter");
		expect(
			calculateEmbeddingCost("openai", 2_000_000, {
				baseUrl: "https://openrouter.ai/api/v1",
				rates: { openrouter: 0.01 },
			}),
		).toBe(0.02);
	});

	it("keeps local providers free and uses the OpenAI default rate", () => {
		expect(calculateEmbeddingCost("ollama", 100_000)).toBe(0);
		expect(calculateEmbeddingCost("openai", 1_000_000)).toBe(DEFAULT_EMBEDDING_COST_RATES.openai);
		expect(calculateEmbeddingCost("unknown", 1_000_000)).toBeNull();
	});
});
