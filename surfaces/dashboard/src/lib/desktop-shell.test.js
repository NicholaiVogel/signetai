import { afterEach, describe, expect, it } from "bun:test";
import { desktopApiBase, isDesktopShell } from "./desktop-shell";

const originalWindow = globalThis.window;

afterEach(() => {
	if (originalWindow === undefined) {
		Reflect.deleteProperty(globalThis, "window");
	} else {
		Object.defineProperty(globalThis, "window", { value: originalWindow, writable: true, configurable: true });
	}
});

describe("desktop shell detection", () => {
	it("treats the Electron app protocol as desktop even before bridge access", () => {
		Object.defineProperty(globalThis, "window", {
			value: { location: { protocol: "app:" } },
			writable: true,
			configurable: true,
		});

		expect(isDesktopShell()).toBe(true);
		expect(desktopApiBase()).toBe("");
	});

	it("uses the preload bridge daemon base when available", () => {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "app:" },
				signetDesktop: { daemonPort: 3850, daemonBaseUrl: "http://localhost:3850" },
			},
			writable: true,
			configurable: true,
		});

		expect(isDesktopShell()).toBe(true);
		expect(desktopApiBase()).toBe("http://localhost:3850");
	});
});
