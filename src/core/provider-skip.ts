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

/** True when the active model's provider (or provider:api) is in skipForProviders. */
export function matchesSkippedProvider(
  config: { skipForProviders?: string[] },
  model: unknown,
): boolean {
  const list = config.skipForProviders;
  if (
    !list ||
    list.length === 0 ||
    model === null ||
    typeof model !== "object"
  ) {
    return false;
  }
  const { provider, api } = model as { provider?: unknown; api?: unknown };
  if (typeof provider !== "string" || provider.length === 0) return false;
  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [entryProvider, entryApi] = trimmed.split(":", 2);
    if (entryProvider !== provider) continue;
    // Bare provider entry skips any api of that provider; "provider:api"
    // skips only that exact api (e.g. "openai-codex:openai-codex-responses").
    if (entryApi === undefined || entryApi === api) return true;
  }
  return false;
}
