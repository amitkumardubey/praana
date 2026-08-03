export interface SelectItem {
  label: string;
  value: string;
  description?: string;
}
import {
  listKnownProviders,
  listAvailableProviders,
  isProviderAvailable,
} from "../llm.js";
import { getProviderEnvKey, SETUP_UNSUPPORTED_PROVIDERS } from "../provider-registry.js";
import { hasCredentials } from "../credentials.js";
import { isOAuthOnlyProvider, supportsOAuthLogin } from "../oauth.js";

/** Special value for the "Custom OpenAI-compatible endpoint" picker entry. */
export const CUSTOM_PROVIDER_VALUE = "__custom__";

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
    return { value: provider, label: provider, description };
  });

  // Prepend the custom OpenAI-compatible provider option.
  return [
    {
      value: CUSTOM_PROVIDER_VALUE,
      label: "Custom OpenAI-compatible endpoint",
      description: "vLLM, LM Studio, Ollama, local llama.cpp, etc.",
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
