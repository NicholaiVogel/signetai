/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT = join(import.meta.dir, "../src/content/docs");
const API_ANCHOR = "post-api-sources-discord";

test("Discord source API links target an explicit stable anchor", () => {
	const api = readFileSync(join(CONTENT, "api/documents-sources.md"), "utf8");
	expect(api).toContain(`<a id="${API_ANCHOR}"></a>\n\n### POST /api/sources/discord`);

	for (const page of ["dashboard.md", "sources.md"]) {
		const source = readFileSync(join(CONTENT, page), "utf8");
		expect(source).toContain(`/api/documents-sources/#${API_ANCHOR}`);
	}
});
