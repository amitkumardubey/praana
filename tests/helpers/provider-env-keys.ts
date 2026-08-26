import { PROVIDER_REGISTRY } from "../../src/provider-registry.js";

/**
 * Every env var name that can make a provider look "available":
 * registry primary keys + aliases, and generic GitHub token vars accepted for Copilot.
 */
export function providerEnvKeyNames(): string[] {
  const names = new Set<string>([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "COPILOT_GITHUB_TOKEN",
  ]);
  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    if (entry.envKey) names.add(entry.envKey);
    for (const alias of entry.envKeyAliases ?? []) names.add(alias);
  }
  return [...names];
}
