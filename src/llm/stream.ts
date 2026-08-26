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
} from "./types.js";
import { getDriverForProvider } from "./resolver.js";
import { resolveProviderAuth } from "./auth.js";
import { getUserProviderConfig } from "../provider-registry.js";

/**
 * Execute a streaming LLM response using the appropriate protocol driver.
 */
export async function* streamLlmResponse(
  req: StreamRequest,
): AsyncIterable<StreamEvent> {
  const customConfig = getUserProviderConfig(req.provider);
  const auth = resolveProviderAuth(req.provider, customConfig?.env_key);

  if (!auth) {
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

  // Merge custom baseUrl or headers if user-declared
  const mergedAuth = {
    ...auth,
    ...(customConfig?.base_url ? { baseUrl: customConfig.base_url } : {}),
    ...(customConfig?.headers ? { headers: customConfig.headers } : {}),
  };

  const driver = getDriverForProvider(req.provider);
  yield* driver.stream(req, mergedAuth);
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
