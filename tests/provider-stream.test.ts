import { afterEach, describe, expect, it, vi } from "vitest";

import { captureRegisteredProviderStreams, createBridgeStreamFn } from "../src/om/provider-stream.js";

describe("custom provider stream bridge", () => {
	afterEach(() => {
		delete (globalThis as any)[Symbol.for("pi-blackhole:provider-streams")];
	});

	it("discovers custom streams through the public model registry API", () => {
		const customStream = vi.fn();
		const registry = {
			getRegisteredProviderIds: () => ["custom-provider"],
			getRegisteredProviderConfig: (providerId: string) => providerId === "custom-provider"
				? { api: "custom-api", streamSimple: customStream }
				: undefined,
		};
		const providerStreams = new Map<string, Function>();

		captureRegisteredProviderStreams(registry as any, providerStreams);

		expect(providerStreams.get("custom-api")).toBe(customStream);
	});

	it("uses the discovered stream for a custom API", () => {
		const fallbackStream = vi.fn();
		const customStream = vi.fn(() => "custom-result");
		const key = Symbol.for("pi-blackhole:provider-streams");
		(globalThis as any)[key] = new Map([["custom-api", customStream]]);
		const bridge = createBridgeStreamFn(fallbackStream);

		expect(bridge({ api: "custom-api" }, "context", "options")).toBe("custom-result");
		expect(customStream).toHaveBeenCalledOnce();
		expect(fallbackStream).not.toHaveBeenCalled();
	});
});
