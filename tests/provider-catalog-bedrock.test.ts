import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fetchBedrockLiveCatalog } from "../src/bedrock/catalog.js";
import {
  providerSupportsLiveCatalog,
  resetProviderCatalogCacheForTests,
} from "../src/provider-catalog.js";

describe("bedrock live catalog", () => {
  beforeEach(() => resetProviderCatalogCacheForTests());
  afterEach(() => resetProviderCatalogCacheForTests());

  it("marks amazon-bedrock as live-catalog capable", () => {
    expect(providerSupportsLiveCatalog("amazon-bedrock")).toBe(true);
  });

  it("builds id→window map from mocked AWS lists", async () => {
    const models = await fetchBedrockLiveCatalog({
      region: "us-east-1",
      listFoundationModels: async () => [
        {
          modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
        },
      ],
      listInferenceProfiles: async () => [
        {
          inferenceProfileId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
            },
          ],
        },
      ],
    });
    expect(models["us.anthropic.claude-sonnet-4-20250514-v1:0"]).not.toBeUndefined();
    expect(models["anthropic.claude-sonnet-4-20250514-v1:0"]).toBeUndefined();
  });
});
