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

/** Build pi-tui select items for the provider picker (detected providers first). */
export function buildProviderSelectItems(): SelectItem[] {
  const all = listKnownProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p));
  const availableSet = new Set(
    listAvailableProviders().filter((p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p)),
  );

  const sorted = [...all].sort((a, b) => {
    const aAvail = availableSet.has(a);
    const bAvail = availableSet.has(b);
    if (aAvail !== bAvail) return aAvail ? -1 : 1;
    return a.localeCompare(b);
  });

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

  // Prepend the custom OpenAI-compatible provider option.
  return [
    {
      value: CUSTOM_PROVIDER_VALUE,
      label: "Custom OpenAI-compatible endpoint",
      description: "vLLM, LM Studio, Ollama, local llama.cpp, etc.",
      aliases: ["custom", "vllm", "lmstudio", "ollama", "llamacpp", "compatible"],
    },
    ...items,
  ];
}

/** Lines describing providers already configured in the environment. */
export function formatDetectedProviderLines(): string[] {
  const available = listAvailableProviders().filter(
    (p) => !SETUP_UNSUPPORTED_PROVIDERS.has(p),
  );
  if (available.length === 0) return [];
  return [
    "Detected in environment:",
    ...available.map((p) => `  ✓ ${p}`),
  ];
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
