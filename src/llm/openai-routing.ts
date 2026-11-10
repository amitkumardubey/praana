import { getUserProviderConfig, isUserDeclaredProvider, PROVIDER_REGISTRY, type ProviderWireCompat } from "../provider-registry.js";
import type { StreamRequest } from "./types.js";

/**
 * Routing floor for the Chat Completions reasoning+tools limit, NOT a list of
 * models supported by Responses. Match bare, case-sensitive API ids (including
 * dated/variant suffixes), not vendor prefixes or unknown future major versions.
 */
// Non-text-generation variant suffixes never hit Responses. Keep them on Chat
// Completions even when their base model id would otherwise route.
const NON_TEXT_VARIANT_SUFFIX = /audio|realtime|transcribe|tts|image|embedding|moderation|search|chat-latest/;

export function openaiUsesResponses(modelId: string): boolean {
  const match = /^gpt-(5|6)(?:\.(0|[1-9]\d*))?(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(modelId);
  if (!match) return false;
  if (match[1] !== "6" && (match[2] === undefined || Number(match[2]) < 4)) return false;
  const suffix = modelId.replace(/^gpt-(?:5|6)(?:\.\d+)?/, "");
  return !NON_TEXT_VARIANT_SUFFIX.test(suffix);
}

/** The built-in-id Chat override must retain OpenAI's max_completion_tokens. */
export function openaiChatOverrideCompat(provider: string): ProviderWireCompat | undefined {
  const user = getUserProviderConfig(provider);
  if (provider === "openai" && user?.api === "openai-completions" &&
      user.base_url.replace(/\/+$/, "") === PROVIDER_REGISTRY.openai.baseUrl) {
    return { ...PROVIDER_REGISTRY.openai.compat };
  }
  return undefined;
}

export function isFirstPartyOpenAI(req: Pick<StreamRequest, "provider" | "baseUrl" | "baseUrlOverride" | "endpointUrl">): boolean {
  return req.provider === "openai" && !isUserDeclaredProvider(req.provider) &&
    !req.baseUrlOverride && !req.endpointUrl &&
    (req.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "") === "https://api.openai.com/v1";
}

export function shouldUseOpenAIResponses(req: Pick<StreamRequest, "provider" | "model" | "baseUrl" | "baseUrlOverride" | "endpointUrl">): boolean {
  return isFirstPartyOpenAI(req) && openaiUsesResponses(req.model);
}
