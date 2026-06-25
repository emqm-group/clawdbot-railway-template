// Per-model USD pricing — the single source of truth for per-turn cost tracking.
//
// Rates are hardcoded here (and ONLY here) on purpose: they are stable and
// change rarely, and keeping them in one place in this wrapper avoids the
// cross-repo drift we'd get from also putting them in the orchestrator or a
// per-tenant config. This mirrors how the wrapper already owns other root-level
// openclaw config (e.g. tools.alsoAllow).
//
// The block actually written to openclaw.json is DERIVED from the configured
// model chain (primary + fallbacks) by buildModelPricingProviders — only models
// that can serve a turn get a cost entry. So adding a fallback is two edits
// here (its rates + its provider meta) plus the existing fallback env vars.

// USD per 1,000,000 tokens (openclaw ModelCostConfig: input/output/cacheRead/
// cacheWrite — any subset). Keyed by the full "<provider>/<id>" ref exactly as
// it appears in OPENCLAW_DEFAULT_MODEL / OPENCLAW_FALLBACK_MODELS.
export const MODEL_PRICING = {
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01 },
  // Add primary/fallback candidates here as they come into use, e.g.:
  // "anthropic/claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// Per-provider connection metadata. openclaw's ModelProviderSchema is .strict()
// and requires baseUrl (api recommended), so pricing can only attach via a full
// provider block — these restate the same endpoint the built-in catalog already
// uses. Only providers actually in use belong here, with verified values.
export const PROVIDER_META = {
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
  // anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
};

// Split a "<provider>/<id>" model ref into its lowercased provider and bare id
// (the part after the first "/"). The bare id is what openclaw's cost lookup
// matches against the transcript's recorded model.
function parseModelRef(ref) {
  const trimmed = String(ref || "").trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: "", bareId: trimmed };
  return {
    provider: trimmed.slice(0, slash).trim().toLowerCase(),
    bareId: trimmed.slice(slash + 1).trim(),
  };
}

/**
 * Derive the openclaw `models.providers` pricing block for a set of model refs
 * (typically the primary + every fallback). Groups by provider, attaches each
 * model's cost, and reports the refs that could not be priced — a ref is
 * unpriced when it has no MODEL_PRICING entry or its provider has no
 * PROVIDER_META. Pure / no I/O.
 *
 * @param {string[]} modelRefs - e.g. ["google/gemini-2.5-flash-lite", ...]
 * @returns {{ providers: Record<string, {baseUrl,api,models}>, unpriced: string[] }}
 */
export function buildModelPricingProviders(modelRefs) {
  const providers = {};
  const unpriced = [];
  for (const raw of modelRefs || []) {
    const ref = String(raw || "").trim();
    if (!ref) continue;
    const cost = MODEL_PRICING[ref];
    const { provider, bareId } = parseModelRef(ref);
    const meta = PROVIDER_META[provider];
    if (!cost || !meta || !bareId) {
      unpriced.push(ref);
      continue;
    }
    if (!providers[provider]) {
      providers[provider] = { baseUrl: meta.baseUrl, api: meta.api, models: [] };
    }
    if (!providers[provider].models.some((m) => m.id === bareId)) {
      providers[provider].models.push({ id: bareId, name: bareId, cost });
    }
  }
  return { providers, unpriced };
}
