// ============================================================
// PRAANA — Zero-Config Dynamic Model & Provider Resolver
// ============================================================

import type { LlmDriver } from "./drivers/base.js";
import { OpenAICompatibleDriver } from "./drivers/openai.js";
import { AnthropicDriver } from "./drivers/anthropic.js";
import { AzureDriver } from "./drivers/azure.js";
import { GoogleDriver } from "./drivers/google.js";
import { BedrockDriver } from "./drivers/bedrock.js";
import { isProviderAuthenticated } from "./auth.js";
import { loadUserSettings } from "../user-settings.js";
import type { PraanaConfig } from "../types.js";
import { getUserProviderConfig, isUserDeclaredProvider } from "../provider-registry.js";

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  openrouter: "anthropic/claude-sonnet-4-6",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  google: "gemini-2.0-flash",
  vertex: "gemini-2.0-flash",
  azure: "gpt-4o",
  "amazon-bedrock": "anthropic.claude-sonnet-4-20250514-v1:0",
  ollama: "llama3",
};

/** Precedence order for auto-detecting an active provider from credentials. */
const DETECTION_PRECEDENCE: string[] = [
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "google",
  "groq",
  "azure",
  "amazon-bedrock",
  "ollama",
];

const drivers: Record<string, LlmDriver> = {
  anthropic: new AnthropicDriver(),
  openai: new OpenAICompatibleDriver(),
  openrouter: new OpenAICompatibleDriver(),
  deepseek: new OpenAICompatibleDriver(),
  groq: new OpenAICompatibleDriver(),
  ollama: new OpenAICompatibleDriver(),
  azure: new AzureDriver(),
  google: new GoogleDriver(),
  vertex: new GoogleDriver(),
  "amazon-bedrock": new BedrockDriver(),
};

/**
 * Get the appropriate protocol driver instance for a provider.
 */
export function getDriverForProvider(provider: string): LlmDriver {
  if (drivers[provider]) {
    return drivers[provider];
  }
  // Check user declared providers
  if (isUserDeclaredProvider(provider)) {
    return drivers.openai; // User-declared providers default to OpenAI-compatible
  }
  return drivers.openai;
}

/**
 * Dynamically resolve the active provider and model in priority order:
 * 1. CLI flag / PRAANA_MODEL env override
 * 2. Optional explicit config pin in praana.config.toml
 * 3. User persistent settings (~/.praana/settings.json)
 * 4. Auto-detect from authenticated credentials in credentials.json or env
 * 5. Fallback default
 */
export function resolveActiveModelAndProvider(config?: PraanaConfig): {
  provider: string;
  model: string;
} {
  // 1. Environment / CLI override
  if (process.env.PRAANA_MODEL?.trim()) {
    const raw = process.env.PRAANA_MODEL.trim();
    if (raw.includes("/")) {
      const [p, ...rest] = raw.split("/");
      return { provider: p, model: rest.join("/") };
    }
    return { provider: config?.llm?.provider || "openrouter", model: raw };
  }

  // 2. Explicit Config Pin
  if (config?.llm?.provider && config?.llm?.model) {
    return { provider: config.llm.provider, model: config.llm.model };
  }

  // 3. User Settings (~/.praana/settings.json)
  const { settings } = loadUserSettings();
  if (settings.provider && settings.model && isProviderAuthenticated(settings.provider)) {
    return { provider: settings.provider, model: settings.model };
  }

  // 4. Auto-Detect from Authenticated Credentials
  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAuthenticated(provider)) {
      const defaultModel = DEFAULT_MODELS[provider] || "gpt-4o";
      return { provider, model: defaultModel };
    }
  }

  // 5. Fallback default
  return {
    provider: config?.llm?.provider || "openrouter",
    model: config?.llm?.model || "anthropic/claude-sonnet-4-6",
  };
}
