// ============================================================
// PRAANA — Zero-Config Dynamic Model & Provider Resolver
// ============================================================

import type { LlmDriver } from "./drivers/base.js";
import { OpenAICompatibleDriver } from "./drivers/openai.js";
import { AnthropicDriver } from "./drivers/anthropic.js";
import { AzureDriver } from "./drivers/azure.js";
import { GoogleDriver } from "./drivers/google.js";
import { BedrockDriver } from "./drivers/bedrock.js";
import { OpenAIResponsesDriver } from "./drivers/responses.js";
import { isProviderAuthenticated } from "./auth.js";
import { loadUserSettings } from "../user-settings.js";
import type { PraanaConfig } from "../types.js";
import {
  PROVIDER_REGISTRY,
  getUserProviderConfig,
  isUserDeclaredProvider,
} from "../provider-registry.js";

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
  "deepseek",
  "groq",
  "google",
  "mistral",
  "xai",
  "fireworks",
  "together",
  "opencode",
  "umans",
  "poolside",
  "openrouter",
  "amazon-bedrock",
  "ollama",
];

const openaiCompat = new OpenAICompatibleDriver();
const anthropic = new AnthropicDriver();
const azure = new AzureDriver();
const google = new GoogleDriver();
const bedrock = new BedrockDriver();
const responses = new OpenAIResponsesDriver();

/**
 * Get the appropriate protocol driver instance for a provider.
 */
export function getDriverForProvider(provider: string, api?: string): LlmDriver {
  const resolvedApi =
    api ||
    getUserProviderConfig(provider)?.api ||
    PROVIDER_REGISTRY[provider]?.api;

  switch (resolvedApi) {
    case "anthropic-messages":
      return anthropic;
    case "google-generative-ai":
      return google;
    case "bedrock-converse-stream":
      return bedrock;
    case "azure-openai-responses":
      return azure;
    case "openai-codex-responses":
    case "openai-responses":
      return responses;
    default:
      break;
  }

  if (provider === "azure") return azure;
  if (provider === "vertex" || provider === "google") return google;
  if (provider === "amazon-bedrock") return bedrock;
  if (provider === "anthropic" || provider === "github-copilot") return anthropic;
  if (provider === "openai-codex") return responses;
  if (isUserDeclaredProvider(provider)) return openaiCompat;
  return openaiCompat;
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
  if (process.env.PRAANA_MODEL?.trim()) {
    const raw = process.env.PRAANA_MODEL.trim();
    if (raw.includes("/")) {
      const [p, ...rest] = raw.split("/");
      return { provider: p, model: rest.join("/") };
    }
    return { provider: config?.llm?.provider || "openrouter", model: raw };
  }

  if (config?.llm?.provider && config?.llm?.model) {
    return { provider: config.llm.provider, model: config.llm.model };
  }

  const { settings } = loadUserSettings();
  if (settings.provider && settings.model && isProviderAuthenticated(settings.provider)) {
    return { provider: settings.provider, model: settings.model };
  }

  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAuthenticated(provider)) {
      const defaultModel = DEFAULT_MODELS[provider] || "gpt-4o";
      return { provider, model: defaultModel };
    }
  }

  return {
    provider: config?.llm?.provider || "openrouter",
    model: config?.llm?.model || "anthropic/claude-sonnet-4-6",
  };
}
