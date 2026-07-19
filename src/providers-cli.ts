import {
  getMissingKeyMessage,
  isProviderAvailable,
  listKnownProviders,
} from "./llm.js";

export interface ProviderCliEntry {
  name: string;
  available: boolean;
  disabledReason?: string;
}

/**
 * List providers for `praana providers`.
 * Default: configured/available only. Pass `includeUnavailable` for every known provider.
 */
export function listProvidersForCli(opts?: {
  includeUnavailable?: boolean;
}): ProviderCliEntry[] {
  const includeUnavailable = opts?.includeUnavailable === true;
  const names = includeUnavailable
    ? listKnownProviders()
    : listKnownProviders().filter((p) => isProviderAvailable(p));

  return names.map((name) => {
    const available = isProviderAvailable(name);
    if (available) return { name, available: true };
    return {
      name,
      available: false,
      disabledReason:
        getMissingKeyMessage(name) ?? `Provider "${name}" is not configured`,
    };
  });
}

/** Format provider entries for stdout (mirrors models CLI style). */
export function formatProvidersCliOutput(entries: ProviderCliEntry[]): string {
  if (entries.length === 0) {
    return "No configured providers found. Set an API key, or pass --all to list every known provider.";
  }

  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.available) {
      lines.push(entry.name);
    } else {
      lines.push(
        `${entry.name} (unavailable: ${entry.disabledReason ?? "not configured"})`,
      );
    }
  }
  return lines.join("\n");
}
