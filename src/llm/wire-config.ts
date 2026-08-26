import {
  PROVIDER_REGISTRY,
  getUserProviderRegistryEntry,
  type ProviderWireCompat,
} from "../provider-registry.js";

export interface ProviderWireDefaults {
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: ProviderWireCompat;
  api?: string;
}

/**
 * Registry / user-declared wire defaults for a provider.
 * User-declared `[providers.*]` entries take precedence.
 */
export function resolveProviderWireDefaults(provider: string): ProviderWireDefaults {
  const user = getUserProviderRegistryEntry(provider);
  if (user) {
    return {
      baseUrl: user.baseUrl || undefined,
      headers: user.headers,
      compat: user.compat,
      api: user.api,
    };
  }
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) return {};
  return {
    baseUrl: entry.baseUrl || undefined,
    headers: entry.headers,
    compat: entry.compat,
    api: entry.api,
  };
}
