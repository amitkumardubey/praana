// ============================================================
// PRAANA — Microsoft Azure OpenAI Wire Protocol Driver
// ============================================================

import { OpenAICompatibleDriver } from "./openai.js";
import type { StreamRequest, StreamEvent, ResolvedAuth } from "../types.js";

export class AzureDriver extends OpenAICompatibleDriver {
  override readonly protocol: string = "azure";

  override async *stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview";
    const resourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || req.model;

    let baseUrl = req.baseUrl || auth.baseUrl;
    if (!baseUrl && resourceName) {
      baseUrl = `https://${resourceName}.openai.azure.com/openai/deployments/${deploymentName}`;
    } else if (!baseUrl) {
      baseUrl = `https://api.openai.azure.com/openai/deployments/${deploymentName}`;
    }

    const azureUrl = baseUrl.includes("?")
      ? `${baseUrl}&api-version=${apiVersion}`
      : `${baseUrl}?api-version=${apiVersion}`;

    const headers: Record<string, string> = {
      ...(auth.apiKey ? { "api-key": auth.apiKey } : {}),
      ...(auth.bearerToken ? { Authorization: `Bearer ${auth.bearerToken}` } : {}),
      ...(req.headers || {}),
      ...(auth.headers || {}),
    };

    const azureReq: StreamRequest = {
      ...req,
      baseUrl: azureUrl,
      headers,
    };

    yield* super.stream(azureReq, { ...auth, baseUrl: azureUrl, headers });
  }
}
