import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureRegisteredProviderStreams,
  createBridgeStreamFn,
  createProviderFetch,
} from "../src/om/provider-stream.js";

const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");
const originalDispatcher = (globalThis as any)[dispatcherSymbol];

describe("custom provider stream bridge", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-blackhole:provider-streams")];
    vi.unstubAllGlobals();
    if (originalDispatcher === undefined) {
      delete (globalThis as any)[dispatcherSymbol];
    } else {
      (globalThis as any)[dispatcherSymbol] = originalDispatcher;
    }
  });

  it("discovers custom streams through the public model registry API", () => {
    const customStream = vi.fn();
    const registry = {
      getRegisteredProviderIds: () => ["custom-provider"],
      getRegisteredProviderConfig: (providerId: string) =>
        providerId === "custom-provider"
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

    expect(bridge({ api: "custom-api" }, "context", {})).toBe("custom-result");
    expect(customStream).toHaveBeenCalledOnce();
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("overrides body idle timeout without replacing the global dispatcher", async () => {
    const dispatch = vi.fn(() => true);
    (globalThis as any)[dispatcherSymbol] = { dispatch };
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal("fetch", fetchMock);

    await createProviderFetch()("https://example.com");
    const defaultDispatcher = fetchMock.mock.calls[0]?.[1]?.dispatcher;
    defaultDispatcher.dispatch({ path: "/default" }, "handler");

    await createProviderFetch(120_000)("https://example.com");
    const configuredDispatcher = fetchMock.mock.calls[1]?.[1]?.dispatcher;
    configuredDispatcher.dispatch({ path: "/configured" }, "handler");

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      { path: "/default", bodyTimeout: 300_000 },
      "handler",
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      { path: "/configured", bodyTimeout: 120_000 },
      "handler",
    );
    expect((globalThis as any)[dispatcherSymbol]).toEqual({ dispatch });
  });
});
