// ============================================================
// PRAANA — Microsoft Azure OpenAI Wire Protocol Driver
// ============================================================

import { OpenAICompatibleDriver } from "./openai.js";
import type { StreamRequest, StreamEvent, ResolvedAuth } from "../types.js";
import { joinUrl } from "../url.js";

export class AzureDriver extends OpenAICompatibleDriver {
  override readonly protocol: string = "azure";

  override async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview";
    const resourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || req.model;

    let baseUrl = (req.baseUrl || auth.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl && resourceName) {
      baseUrl = `https://${resourceName}.openai.azure.com/openai/deployments/${encodeURIComponent(deploymentName)}`;
    }

    if (!baseUrl) {
      yield {
        type: "error",
        error: new Error(
          "Azure OpenAI is not configured. Set AZURE_OPENAI_RESOURCE_NAME or llm.base_url.",
        ),
        status: 400,
        retryable: false,
      };
      return;
    }

    // If the caller already pointed at /chat/completions, don't append twice.
    const deploymentRoot = baseUrl.replace(/\/chat\/completions\/?$/i, "");
    const endpointUrl = joinUrl(deploymentRoot, "/chat/completions", {
      "api-version": apiVersion,
      ...req.query,
    });

    const headers: Record<string, string> = {
      ...(auth.apiKey ? { "api-key": auth.apiKey } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const azureReq: StreamRequest = {
      ...req,
      endpointUrl,
      baseUrl: deploymentRoot,
      headers,
      query: undefined,
    };

    // Do not pass apiKey to the OpenAI driver — it would send Authorization: Bearer.
    yield* super.stream(azureReq, {
      bearerToken: auth.bearerToken,
      headers,
      baseUrl: deploymentRoot,
    });
  }
}
