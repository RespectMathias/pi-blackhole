/**
 * Provider-aware engine coordination.
 *
 * Extensions like pi-codex-compaction own compaction for specific providers
 * (OpenAI Codex native remote compaction, preserving opaque checkpoints).
 * When the active model's provider is listed in `skipForProviders`, blackhole
 * steps aside entirely — no compaction, no observational-memory
 * consolidation — so exactly one compaction engine acts per turn, regardless
 * of extension registration order.
 */

type ProviderModel = { provider: string; api?: unknown };

function isProviderModel(model: unknown): model is ProviderModel {
  if (model === null || typeof model !== "object" || !("provider" in model)) {
    return false;
  }

  const { provider } = model;
  return typeof provider === "string" && provider.length > 0;
}

export function getModelProvider(model: unknown): string | undefined {
  return isProviderModel(model) ? model.provider : undefined;
}

/** True when the active model's provider (or provider:api) is in skipForProviders. */
export function matchesSkippedProvider(
  config: { skipForProviders?: string[] },
  model: unknown,
): boolean {
  const list = config.skipForProviders;
  if (!list || list.length === 0 || !isProviderModel(model)) return false;

  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [entryProvider, entryApi] = trimmed.split(":", 2);
    if (entryProvider !== model.provider) continue;
    // Bare provider entry skips any api. "provider:" targets models with no
    // api, while "provider:api" matches that exact api.
    if (
      entryApi === undefined ||
      (entryApi === "" ? model.api === undefined : entryApi === model.api)
    ) {
      return true;
    }
  }
  return false;
}
