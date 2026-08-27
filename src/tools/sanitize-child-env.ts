import {
  PROVIDER_REGISTRY,
  getUserProviderEnvKey,
  listUserDeclaredProviderIds,
} from "../provider-registry.js";
import { PROVIDER_ENV_MAPPINGS } from "../llm/auth.js";

/** Env vars that are credentials for LLM providers but also useful to user shells. */
const KEEP_IN_CHILD = new Set([
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

const ALWAYS_STRIP = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
];

/** Env var names that the shell tool must not inherit. */
export function collectSensitiveEnvKeys(): string[] {
  const keys = new Set<string>();

  for (const extra of ALWAYS_STRIP) keys.add(extra);

  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    if (entry.envKey) keys.add(entry.envKey);
    for (const alias of entry.envKeyAliases ?? []) keys.add(alias);
  }

  for (const mapping of Object.values(PROVIDER_ENV_MAPPINGS)) {
    if (mapping.canonical) keys.add(mapping.canonical);
    for (const alias of mapping.aliases ?? []) keys.add(alias);
  }

  for (const id of listUserDeclaredProviderIds()) {
    const envKey = getUserProviderEnvKey(id);
    if (envKey) keys.add(envKey);
  }

  return [...keys].filter((name) => name && !KEEP_IN_CHILD.has(name));
}

/** Copy of `env` with LLM provider API keys removed. */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of collectSensitiveEnvKeys()) {
    delete out[key];
  }
  return out;
}
