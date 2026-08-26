// ============================================================
// PRAANA — Stream Execution Engine Facade
// ============================================================

import type {
  StreamRequest,
  StreamEvent,
  StreamResult,
  AssistantMessage,
  ToolCall,
  ProviderUsage,
  ResolvedAuth,
} from "./types.js";
import { getDriverForProvider } from "./resolver.js";
import { resolveProviderAuth } from "./auth.js";
import { getUserProviderConfig } from "../provider-registry.js";
import { resolveProviderWireDefaults } from "./wire-config.js";
import { resolveOAuthModelAuth, resolveCopilotModelAuth } from "../oauth.js";

/**
 * Execute a streaming LLM response using the appropriate protocol driver.
 */
export async function* streamLlmResponse(
  req: StreamRequest,
): AsyncIterable<StreamEvent> {
  const customConfig = getUserProviderConfig(req.provider);
  const wire = resolveProviderWireDefaults(req.provider);
  let auth = resolveProviderAuth(req.provider, customConfig?.env_key);

  if (!auth && !req.apiKey && !req.bearerToken) {
    yield {
      type: "error",
      error: new Error(
        `Missing credentials for provider "${req.provider}". Run /login ${req.provider} or set the appropriate API key.`,
      ),
      status: 401,
      retryable: false,
    };
    return;
  }

  auth = auth ?? {};

  // Request-level overlays from the turn loop (OAuth refresh / RuntimeModel).
  if (req.apiKey) auth = { ...auth, apiKey: req.apiKey };
  if (req.bearerToken) auth = { ...auth, bearerToken: req.bearerToken };

  // Copilot's Anthropic-compatible host wants Bearer, never x-api-key.
  // Exchange a GitHub OAuth token when the caller did not already pass a
  // resolved Copilot API token.
  if (req.provider === "github-copilot") {
    const token = auth.bearerToken || auth.apiKey;
    if (token) {
      if (!req.apiKey && !req.bearerToken) {
        try {
          const copilot = await resolveCopilotModelAuth(token);
          auth = {
            ...auth,
            bearerToken: copilot.apiKey,
            apiKey: undefined,
            headers: { ...auth.headers, ...copilot.headers },
            baseUrl: copilot.baseUrl ?? auth.baseUrl,
          };
        } catch {
          auth = { ...auth, bearerToken: token, apiKey: undefined };
        }
      } else {
        auth = { ...auth, bearerToken: token, apiKey: undefined };
      }
    }
  } else if (!req.apiKey && !req.bearerToken) {
    try {
      const oauth = await resolveOAuthModelAuth(req.provider);
      if (oauth?.apiKey) {
        auth = {
          ...auth,
          bearerToken: oauth.apiKey,
          apiKey: auth.apiKey,
          headers: { ...auth.headers, ...oauth.headers },
          baseUrl: oauth.baseUrl ?? auth.baseUrl,
        };
      }
    } catch {
      // Fall through with stored/env credentials.
    }
  }

  const mergedAuth: ResolvedAuth = {
    ...auth,
    baseUrl: req.baseUrl || auth.baseUrl || customConfig?.base_url || wire.baseUrl,
    headers: {
      ...wire.headers,
      ...customConfig?.headers,
      ...auth.headers,
      ...req.headers,
    },
  };

  const mergedReq: StreamRequest = {
    ...req,
    baseUrl: req.baseUrl || mergedAuth.baseUrl,
    headers: mergedAuth.headers,
    compat: req.compat ?? wire.compat,
    api: req.api ?? wire.api,
  };

  const driver = getDriverForProvider(req.provider, mergedReq.api);
  yield* driver.stream(mergedReq, mergedAuth);
}

/**
 * Execute a full LLM completion to the end and return the aggregated StreamResult.
 * Used by summarizers, one-shot extractors, and non-interactive workflows.
 */
export async function completeLlmResponse(
  req: StreamRequest,
): Promise<StreamResult> {
  let fullResponse = "";
  let thinking = "";
  let thinkingSignature: string | undefined;
  const pendingToolCalls: ToolCall[] = [];
  let finalMessage: AssistantMessage | null = null;
  let finalReason: StreamResult["finalReason"] = "stop";
  let errorMessage: string | undefined;
  let providerUsage: ProviderUsage | null = null;
  let interrupted = false;

  for await (const event of streamLlmResponse(req)) {
    if (event.type === "text_delta") {
      fullResponse += event.delta;
    } else if (event.type === "thinking_delta") {
      thinking += event.delta;
    } else if (event.type === "tool_call_end") {
      pendingToolCalls.push(event.toolCall);
    } else if (event.type === "usage") {
      providerUsage = event.usage;
    } else if (event.type === "done") {
      finalReason = event.reason;
      finalMessage = event.message;
      thinkingSignature = event.message.thinkingSignature ?? thinkingSignature;
      if (event.reason === "abort") {
        interrupted = true;
      }
    } else if (event.type === "error") {
      finalReason = "error";
      errorMessage = event.error.message;
    }
  }

  return {
    fullResponse,
    thinking,
    thinkingSignature,
    pendingToolCalls,
    finalMessage,
    finalReason,
    errorMessage,
    providerUsage,
    assistantTokens: providerUsage?.output ?? 0,
    interrupted,
  };
}
