import { expect, test } from "bun:test";
import { join } from "node:path";

interface PackageJson {
	readonly devDependencies: Readonly<Record<string, string>>;
	readonly scripts: Readonly<Record<string, string>>;
}

interface BiomeConfig {
	readonly $schema: string;
}

const ROOT = join(import.meta.dir, "..");

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Bun.file(join(ROOT, path)).text()) as T;
}

test("Biome 2 baseline exposes non-writing quality checks", async () => {
	const packageJson = await readJson<PackageJson>("package.json");
	const biomeConfig = await readJson<BiomeConfig>("biome.json");

	expect(packageJson.devDependencies["@biomejs/biome"]).toMatch(/^\^2\./);
	expect(biomeConfig.$schema).toContain("/schemas/2.");
	expect(packageJson.scripts.lint).toBe("bun run lint:check");
	expect(packageJson.scripts["lint:check"]).toBe("biome check .");
	expect(packageJson.scripts["format:check"]).toBe("biome format .");
});
