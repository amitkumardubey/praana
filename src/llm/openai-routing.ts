import { isUserDeclaredProvider } from "../provider-registry.js";
import type { StreamRequest } from "./types.js";

/**
 * Routing floor for the Chat Completions reasoning+tools limit, NOT a list of
 * models supported by Responses. Match bare, case-sensitive API ids (including
 * dated/variant suffixes), not vendor prefixes or unknown future major versions.
 */
export function openaiUsesResponses(modelId: string): boolean {
  const match = /^gpt-(5|6)(?:\.(0|[1-9]\d*))?(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(modelId);
  return !!match && (match[1] === "6" || (match[2] !== undefined && Number(match[2]) >= 4));
}

export function isFirstPartyOpenAI(req: Pick<StreamRequest, "provider" | "baseUrl" | "baseUrlOverride" | "endpointUrl">): boolean {
  return req.provider === "openai" && !isUserDeclaredProvider(req.provider) &&
    !req.baseUrlOverride && !req.endpointUrl &&
    (req.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "") === "https://api.openai.com/v1";
}

export function shouldUseOpenAIResponses(req: Pick<StreamRequest, "provider" | "model" | "baseUrl" | "baseUrlOverride" | "endpointUrl">): boolean {
  return isFirstPartyOpenAI(req) && openaiUsesResponses(req.model);
}
