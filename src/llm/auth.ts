// ============================================================
// PRAANA — Unified Auth & Credential Resolution
// ============================================================

import { resolveApiKey, hasApiKey, getOAuthToken } from "../credentials.js";
import type { ResolvedAuth } from "./types.js";
import { getProviderEnvKeys, getUserProviderEnvKey } from "../provider-registry.js";
import {
  isBedrockAvailable,
  resolveBedrockBearerToken,
} from "../bedrock/credentials.js";

/** Extra env aliases not always listed on the registry entry. */
export const PROVIDER_ENV_MAPPINGS: Record<string, { canonical: string; aliases?: string[] }> = {
  anthropic: { canonical: "ANTHROPIC_API_KEY" },
  openai: { canonical: "OPENAI_API_KEY" },
  openrouter: { canonical: "OPENROUTER_API_KEY", aliases: ["OPENAI_API_KEY"] },
  deepseek: { canonical: "DEEPSEEK_API_KEY" },
  groq: { canonical: "GROQ_API_KEY" },
  google: { canonical: "GEMINI_API_KEY", aliases: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  vertex: { canonical: "GCP_ACCESS_TOKEN" },
  azure: { canonical: "AZURE_OPENAI_API_KEY", aliases: ["AZURE_API_KEY"] },
  "amazon-bedrock": {
    canonical: "AWS_BEARER_TOKEN_BEDROCK",
    aliases: ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
  },
  ollama: { canonical: "" },
  "github-copilot": { canonical: "COPILOT_GITHUB_TOKEN", aliases: ["GH_TOKEN", "GITHUB_TOKEN"] },
};

/** List of providers that do not require an API key by default. */
export const KEYLESS_PROVIDERS = new Set(["ollama"]);

/**
 * Resolve credentials for a provider in priority order:
 * 1. Stored API key or active OAuth token (~/.praana/credentials.json)
 * 2. Environment variables (process.env)
 * 3. Keyless / ambient fallback (Ollama, Bedrock AWS chain, Vertex ADC)
 */
export function resolveProviderAuth(provider: string, customEnvKey?: string | null): ResolvedAuth | null {
  if (KEYLESS_PROVIDERS.has(provider)) {
    return { isKeyless: true };
  }

  if (provider === "amazon-bedrock") {
    const bearer = resolveBedrockBearerToken();
    if (bearer) return { bearerToken: bearer };
    if (isBedrockAvailable()) return { awsAmbient: true };
    return null;
  }

  if (provider === "vertex") {
    const token = process.env.GCP_ACCESS_TOKEN?.trim();
    if (token) return { bearerToken: token };
    if (hasApiKey("vertex")) {
      const key = resolveApiKey("vertex");
      if (key && !looksLikeFilePath(key)) return { bearerToken: key };
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
      return { googleAdc: true };
    }
    return null;
  }

  if (hasApiKey(provider)) {
    const key = resolveApiKey(provider);
    if (key) {
      if (provider === "github-copilot" || provider === "openai-codex") {
        return { bearerToken: key };
      }
      return { apiKey: key };
    }
  }

  const oauthToken = getOAuthToken(provider);
  if (oauthToken?.access) {
    return { bearerToken: oauthToken.access };
  }

  const envKeys = collectEnvKeys(provider, customEnvKey);
  for (const name of envKeys) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    if (provider === "github-copilot" || provider === "openai-codex") {
      return { bearerToken: value };
    }
    if (provider === "vertex") {
      return { bearerToken: value };
    }
    return { apiKey: value };
  }

  return null;
}

/** Check if credentials are present for a provider without throwing. */
export function isProviderAuthenticated(provider: string, customEnvKey?: string | null): boolean {
  return resolveProviderAuth(provider, customEnvKey) !== null;
}

function collectEnvKeys(provider: string, customEnvKey?: string | null): string[] {
  const keys: string[] = [];
  const add = (name: string | null | undefined) => {
    if (name && name.trim()) keys.push(name.trim());
  };
  add(customEnvKey);
  add(getUserProviderEnvKey(provider));
  for (const k of getProviderEnvKeys(provider)) add(k);
  const mapping = PROVIDER_ENV_MAPPINGS[provider];
  if (mapping) {
    add(mapping.canonical);
    for (const alias of mapping.aliases ?? []) add(alias);
  }
  return [...new Set(keys)];
}

function looksLikeFilePath(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\");
}
