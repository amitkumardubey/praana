// ============================================================
// PRAANA — Unified Auth & Credential Resolution
// ============================================================

import { resolveApiKey, hasApiKey, getOAuthToken } from "../credentials.js";
import type { ResolvedAuth } from "./types.js";

/** Canonical environment variables and accepted aliases per provider. */
export const PROVIDER_ENV_MAPPINGS: Record<string, { canonical: string; aliases?: string[] }> = {
  anthropic: { canonical: "ANTHROPIC_API_KEY" },
  openai: { canonical: "OPENAI_API_KEY" },
  openrouter: { canonical: "OPENROUTER_API_KEY", aliases: ["OPENAI_API_KEY"] },
  deepseek: { canonical: "DEEPSEEK_API_KEY" },
  groq: { canonical: "GROQ_API_KEY" },
  google: { canonical: "GEMINI_API_KEY", aliases: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  vertex: { canonical: "GOOGLE_APPLICATION_CREDENTIALS", aliases: ["GCP_ACCESS_TOKEN"] },
  azure: { canonical: "AZURE_OPENAI_API_KEY", aliases: ["AZURE_API_KEY"] },
  "amazon-bedrock": {
    canonical: "AWS_BEARER_TOKEN_BEDROCK",
    aliases: ["AWS_ACCESS_KEY_ID", "AWS_PROFILE"],
  },
  ollama: { canonical: "" }, // Keyless
};

/** List of providers that do not require an API key by default. */
export const KEYLESS_PROVIDERS = new Set(["ollama"]);

/**
 * Resolve credentials for a provider in priority order:
 * 1. Stored API key or active OAuth token (~/.praana/credentials.json)
 * 2. Environment variables (process.env)
 * 3. Keyless fallback (Ollama)
 */
export function resolveProviderAuth(provider: string, customEnvKey?: string | null): ResolvedAuth | null {
  // 1. Check Keyless
  if (KEYLESS_PROVIDERS.has(provider)) {
    return { isKeyless: true };
  }

  // 2. Check Credential Store (~/.praana/credentials.json)
  if (hasApiKey(provider)) {
    const key = resolveApiKey(provider);
    if (key) return { apiKey: key };
  }

  const oauthToken = getOAuthToken(provider);
  if (oauthToken?.access) {
    return { bearerToken: oauthToken.access };
  }

  // 3. Check Environment Variables
  if (customEnvKey && process.env[customEnvKey]?.trim()) {
    return { apiKey: process.env[customEnvKey]!.trim() };
  }

  const mapping = PROVIDER_ENV_MAPPINGS[provider];
  if (mapping) {
    if (mapping.canonical && process.env[mapping.canonical]?.trim()) {
      return { apiKey: process.env[mapping.canonical]!.trim() };
    }
    if (mapping.aliases) {
      for (const alias of mapping.aliases) {
        if (process.env[alias]?.trim()) {
          return { apiKey: process.env[alias]!.trim() };
        }
      }
    }
  }

  // Bedrock special AWS ambient credentials check
  if (provider === "amazon-bedrock") {
    if (
      process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() ||
      (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) ||
      process.env.AWS_PROFILE?.trim()
    ) {
      return {
        bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim(),
        apiKey: process.env.AWS_ACCESS_KEY_ID?.trim(),
      };
    }
  }

  return null;
}

/** Check if credentials are present for a provider without throwing. */
export function isProviderAuthenticated(provider: string, customEnvKey?: string | null): boolean {
  return resolveProviderAuth(provider, customEnvKey) !== null;
}
