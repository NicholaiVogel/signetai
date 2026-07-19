import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { applyPolyfill } from "./bun-socket-polyfill";

describe("destroySoon polyfill", () => {
	let originalDestroySoon: (() => void) | undefined;

	beforeEach(() => {
		originalDestroySoon = (Duplex.prototype as unknown as { destroySoon(): void }).destroySoon;
		delete (Duplex.prototype as unknown as Record<string, unknown>).destroySoon;
	});

	afterEach(() => {
		if (originalDestroySoon) {
			(Duplex.prototype as unknown as { destroySoon(): void }).destroySoon = originalDestroySoon;
		}
	});

	test("Duplex lacks destroySoon before polyfill (simulates Bun HTTP socket)", () => {
		const socket = new Duplex({
			read() {},
			write(_c, _e, cb) {
				cb();
			},
		});
		expect(typeof (socket as unknown as { destroySoon(): void }).destroySoon).toBe("undefined");
	});

	test("polyfill adds destroySoon to Duplex prototype", () => {
		applyPolyfill();
		const socket = new Duplex({
			read() {},
			write(_c, _e, cb) {
				cb();
			},
		});
		expect(typeof (socket as unknown as { destroySoon(): void }).destroySoon).toBe("function");
	});

	test("destroySoon calls end() on writable socket then destroys after finish", async () => {
		applyPolyfill();
		const socket = new Duplex({
			read() {},
			write(_c, _e, cb) {
				cb();
			},
		});

		let ended = false;
		let destroyed = false;
		socket.on("finish", () => {
			ended = true;
		});
		socket.on("close", () => {
			destroyed = true;
		});

		(socket as unknown as { destroySoon(): void }).destroySoon();

		await new Promise((r) => setTimeout(r, 50));
		expect(ended).toBe(true);
		expect(destroyed).toBe(true);
	});

	test("destroySoon destroys immediately if already finished writing", async () => {
		applyPolyfill();
		const socket = new Duplex({
			read() {},
			write(_c, _e, cb) {
				cb();
			},
		});

		socket.end();
		await new Promise((r) => socket.once("finish", r));

		let destroyed = false;
		socket.on("close", () => {
			destroyed = true;
		});

		(socket as unknown as { destroySoon(): void }).destroySoon();
		await new Promise((r) => setTimeout(r, 50));
		expect(destroyed).toBe(true);
	});

	test("polyfill does not overwrite existing destroySoon", () => {
		const sentinel = function sentinel() {};
		(Duplex.prototype as unknown as { destroySoon(): void }).destroySoon = sentinel as unknown as () => void;

		applyPolyfill();

		expect((Duplex.prototype as unknown as { destroySoon(): void }).destroySoon).toBe(sentinel);
	});
});
