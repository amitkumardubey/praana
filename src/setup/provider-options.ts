import {
  listKnownProviders,
  listAvailableProviders,
  isProviderAvailable,
} from "../llm.js";
import { getProviderEnvKey, SETUP_UNSUPPORTED_PROVIDERS } from "../provider-registry.js";
import { hasCredentials } from "../credentials.js";
import { isOAuthOnlyProvider, supportsOAuthLogin } from "../oauth.js";

export interface SelectItem {
  label: string;
  value: string;
  description?: string;
  /** Extra search terms for the login/setup picker (not shown in the list). */
  aliases?: string[];
}

/** Special value for the "Custom OpenAI-compatible endpoint" picker entry. */
export const CUSTOM_PROVIDER_VALUE = "__custom__";

/**
 * Common names people type when looking for a provider.
 * Exact unique hits also resolve `/login <hint>` and readline name entry.
 */
export const PROVIDER_SEARCH_ALIASES: Record<string, string[]> = {
  openai: ["gpt", "chatgpt"],
  anthropic: ["claude"],
  google: ["gemini", "bard"],
  "amazon-bedrock": ["bedrock", "aws", "amazon"],
  "openai-codex": ["codex", "chatgpt"],
  "github-copilot": ["copilot", "github"],
  xai: ["grok"],
  nvidia: ["nim"],
};

export function searchAliasesForProvider(id: string): string[] {
  return PROVIDER_SEARCH_ALIASES[id] ?? [];
}

/**
 * Map a typed hint to a canonical provider id.
 * Exact id wins; otherwise a unique alias hit. Ambiguous aliases (e.g. chatgpt)
 * return undefined so the picker can filter instead of guessing.
 */
export function resolveProviderHint(
  hint: string,
  knownIds: readonly string[],
): string | undefined {
  const q = hint.trim().toLowerCase();
  if (!q) return undefined;
  const ids = knownIds.filter((id) => id !== CUSTOM_PROVIDER_VALUE);
  if (ids.includes(q)) return q;
  const aliasHits = ids.filter((id) =>
    searchAliasesForProvider(id).some((alias) => alias.toLowerCase() === q),
  );
  if (aliasHits.length === 1) return aliasHits[0];
  return undefined;
}

/** True when a typed hint should stay on the picker (prefix/alias hit, possibly several). */
export function providerHintMatchesList(
  hint: string,
  items: readonly SelectItem[],
): boolean {
  const q = hint.trim().toLowerCase();
  if (!q) return false;
  if (resolveProviderHint(q, items.map((item) => item.value))) return true;
  return items.some((item) => {
    if (item.value === CUSTOM_PROVIDER_VALUE) return false;
    const value = item.value.toLowerCase();
    const label = item.label.toLowerCase();
    if (value.startsWith(q) || label.startsWith(q)) return true;
    if (value.split(/[-_./]/).some((part) => part.startsWith(q))) return true;
    return (item.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(q));
  });
}

/** Resolve a typed number-or-name choice against picker items. */
export function findProviderSelectItem(
  items: readonly SelectItem[],
  query: string,
): SelectItem | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const resolved = resolveProviderHint(
    q,
    items.map((item) => item.value),
  );
  if (resolved) return items.find((item) => item.value === resolved);
  if (q === "custom") {
    return items.find((item) => item.value === CUSTOM_PROVIDER_VALUE);
  }
  return items.find(
    (item) => item.label.toLowerCase() === q || item.value.toLowerCase() === q,
  );
}

/**
 * Resolve a `/logout <hint>` against currently stored provider ids.
 * Unique id/alias → log out immediately. Prefix/shared-alias hits → picker query.
 */
export function resolveStoredProviderHint(
  hint: string,
  storedIds: readonly string[],
): { providerId?: string; pickerQuery?: string } {
  const q = hint.trim().toLowerCase();
  if (!q) return {};
  const resolved = resolveProviderHint(q, storedIds);
  if (resolved) return { providerId: resolved };
  const items: SelectItem[] = storedIds.map((id) => ({
    label: id,
    value: id,
    aliases: searchAliasesForProvider(id),
  }));
  if (providerHintMatchesList(q, items)) return { pickerQuery: q };
  return {};
}

/**
 * Curated "popular hosted" group, in this fixed order. Kept ahead of the
 * alphabetical tail so new users see familiar names first; only providers
 * present in the registry are shown, and ones that are already available
 * stay in the available group ahead of this list.
 */
export const POPULAR_PROVIDER_ORDER: readonly string[] = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "deepseek",
  "groq",
  "mistral",
];

/**
 * Build pi-tui select items for the provider picker.
 * Order: already-available providers (alphabetical) → curated popular hosted
 * group (fixed order) → remaining providers (alphabetical) → custom endpoint.
 */
export function buildProviderSelectItems(): SelectItem[] {
  const all = listKnownProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p));
  const availableSet = new Set(
    listAvailableProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p)),
  );

  const available = [...all]
    .filter((p) => availableSet.has(p))
    .sort((a, b) => a.localeCompare(b));
  const popular = POPULAR_PROVIDER_ORDER.filter(
    (p) => all.includes(p) && !availableSet.has(p),
  );
  const rest = [...all]
    .filter((p) => !availableSet.has(p) && !POPULAR_PROVIDER_ORDER.includes(p))
    .sort((a, b) => a.localeCompare(b));
  const sorted = [...available, ...popular, ...rest];

  const items: SelectItem[] = sorted.map((provider) => {
    const envKey = getProviderEnvKey(provider);
    const available = availableSet.has(provider);
    let description: string;
    if (supportsOAuthLogin(provider)) {
      if (hasCredentials(provider) || available) {
        description = isOAuthOnlyProvider(provider)
          ? "✓ OAuth / subscription"
          : "✓ API key or OAuth";
      } else if (provider === "anthropic") {
        description = "API key or Claude Pro/Max OAuth";
      } else if (provider === "openai-codex") {
        description = "ChatGPT Plus/Pro Codex OAuth";
      } else if (provider === "github-copilot") {
        description = "GitHub Copilot OAuth";
      } else {
        description = "OAuth";
      }
    } else if (provider === "poolside") {
      description = available
        ? "✓ POOLSIDE_API_KEY detected"
        : "Poolside Platform API key";
    } else if (!envKey) {
      if (available && provider === "amazon-bedrock") {
        description = "✓ AWS credentials detected";
      } else if (available) {
        description = "✓ available";
      } else {
        description = "Configure separately";
      }
    } else if (available) {
      description = `✓ ${envKey} detected`;
    } else {
      description = envKey;
    }
    return {
      value: provider,
      label: provider,
      description,
      aliases: searchAliasesForProvider(provider),
    };
  });

  // The custom OpenAI-compatible endpoint stays last: it targets local or
  // self-hosted servers, so hosted providers take precedence in the list.
  items.push({
    value: CUSTOM_PROVIDER_VALUE,
    label: "Custom OpenAI-compatible endpoint",
    description: "Local or self-hosted server (Ollama, LM Studio, vLLM, llama.cpp)",
    aliases: ["custom", "vllm", "lmstudio", "ollama", "llamacpp", "compatible"],
  });
  return items;
}

/** Providers with a usable key (credential store or env), excluding setup-unsupported ones. */
export function listSetupAvailableProviderIds(): string[] {
  return listAvailableProviders().filter(
    (p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p),
  );
}

function formatAvailableProviderLines(available: readonly string[]): string[] {
  if (available.length === 0) return [];
  return [
    "Already available:",
    ...available.map((p) => `  ✓ ${p}`),
  ];
}

/** Lines listing providers that already have credentials. */
export function formatDetectedProviderLines(): string[] {
  return formatAvailableProviderLines(listSetupAvailableProviderIds());
}

/**
 * Intro copy for the provider picker.
 * First run (no config.toml): "No provider configured…" unless keys are already present.
 * Later run: "Update your provider." — never claim nothing is configured.
 */
export function setupProviderIntroLines(
  configExists: boolean,
  detectedIds: readonly string[] = listSetupAvailableProviderIds(),
): string[] {
  const detected = formatAvailableProviderLines(detectedIds);
  const heading = configExists
    ? "Update your provider."
    : detected.length > 0
      ? "Let's set one up."
      : "No provider configured. Let's set one up.";
  const lines = [heading, ""];
  if (detected.length > 0) {
    lines.push(...detected, "");
  }
  lines.push("Choose a provider:");
  return lines;
}

/** @deprecated Readline fallback pagination — kept for CLI setup path. */
export function providerPageLines(
  providers: string[],
  page: number,
  pageSize: number,
): string[] {
  const totalPages = Math.max(1, Math.ceil(providers.length / pageSize));
  const start = page * pageSize;
  const end = Math.min(start + pageSize, providers.length);
  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    lines.push(`  ${i + 1}. ${providers[i]}`);
  }
  lines.push("");
  if (totalPages > 1) {
    lines.push(`  Page ${page + 1}/${totalPages}. Type 'n' for next, 'p' for previous.`);
  }
  return lines;
}

export function listSetupProviderIds(): string[] {
  return buildProviderSelectItems().map((item) => item.value);
}

export { isProviderAvailable };
