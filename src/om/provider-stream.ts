/**
 * Bridge streamSimple to support custom providers via global Symbol.for().
 *
 * When a custom provider is registered (via index.ts at startup), its stream
 * function is stored under a shared global symbol. This module provides the
 * bridge logic so all OM agents (observer, reflector, dropper) use the same
 * custom-provider resolution instead of each duplicating the 15-line function.
 */
interface RegisteredProviderConfig {
  api?: string;
  streamSimple?: Function;
}

interface ProviderRegistry {
  getRegisteredProviderIds?: () => readonly string[];
  getRegisteredProviderConfig?: (
    providerId: string,
  ) => RegisteredProviderConfig | undefined;
  registeredProviders?: Map<string, RegisteredProviderConfig>;
}

export function captureRegisteredProviderStreams(
  registry: ProviderRegistry,
  providerStreams: Map<string, Function>,
): void {
  if (
    registry.getRegisteredProviderIds &&
    registry.getRegisteredProviderConfig
  ) {
    for (const providerId of registry.getRegisteredProviderIds()) {
      const config = registry.getRegisteredProviderConfig(providerId);
      if (
        config?.streamSimple &&
        config.api &&
        !providerStreams.has(config.api)
      ) {
        providerStreams.set(config.api, config.streamSimple);
      }
    }
    return;
  }

  registry.registeredProviders?.forEach((config) => {
    if (config.streamSimple && config.api && !providerStreams.has(config.api)) {
      providerStreams.set(config.api, config.streamSimple);
    }
  });
}

export function createBridgeStreamFn(streamSimple: any) {
  const PROVIDER_STREAMS_KEY = Symbol.for("pi-blackhole:provider-streams");
  return (model: any, ctx: any, opts: any) => {
    const providerStreams: Map<string, Function> | undefined = (
      globalThis as any
    )[PROVIDER_STREAMS_KEY];
    if (!providerStreams) return streamSimple(model, ctx, opts);
    const customFn = model?.api ? providerStreams.get(model.api) : undefined;
    return customFn
      ? customFn(model, ctx, opts)
      : streamSimple(model, ctx, opts);
  };
}
