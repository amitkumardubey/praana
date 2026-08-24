import { getProviders, findEnvKeys } from "@earendil-works/pi-ai/compat";
import { PROVIDER_REGISTRY } from "../../src/provider-registry.js";

/**
 * Every env var name that can make a provider look "available":
 * registry primary keys + aliases, pi-ai catalog keys, and the
 * generic GitHub token vars accepted for Copilot.
 *
 * Tests use this to scrub leaked dev-environment keys so provider
 * detection is deterministic regardless of the host shell.
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
  for (const p of getProviders() as string[]) {
    for (const key of findEnvKeys(p as never) ?? []) names.add(key);
  }
  return [...names];
}
