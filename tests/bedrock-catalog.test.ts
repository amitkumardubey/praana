import { describe, it, expect } from "bun:test";
import {
  foundationModelIdFromArn,
  isChatCapableFoundationModel,
  buildBedrockCatalogIds,
} from "../src/bedrock/catalog.js";

describe("bedrock catalog pure logic", () => {
  it("extracts FM id from ARN", () => {
    expect(
      foundationModelIdFromArn(
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
      ),
    ).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(foundationModelIdFromArn("not-an-arn")).toBeNull();
  });

  it("requires TEXT in/out and excludes non-streaming when false", () => {
    expect(
      isChatCapableFoundationModel({
        modelId: "anthropic.claude-x",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
      }),
    ).toBe(true);
    expect(
      isChatCapableFoundationModel({
        modelId: "amazon.titan-embed",
        inputModalities: ["TEXT"],
        outputModalities: ["EMBEDDING"],
      }),
    ).toBe(false);
    expect(
      isChatCapableFoundationModel({
        modelId: "anthropic.claude-x",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: false,
      }),
    ).toBe(false);
  });

  it("prefers profiles and suppresses covered base ids", () => {
    const ids = buildBedrockCatalogIds({
      foundationModels: [
        {
          modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
        },
        {
          modelId: "amazon.nova-micro-v1:0",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
        },
      ],
      profiles: [
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
        {
          inferenceProfileId: "us.amazon.titan-embed-text-v2:0",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
            },
          ],
        },
      ],
    });
    expect(ids).toContain("us.anthropic.claude-sonnet-4-20250514-v1:0");
    expect(ids).not.toContain("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(ids).toContain("amazon.nova-micro-v1:0");
    expect(ids).not.toContain("us.amazon.titan-embed-text-v2:0");
  });
});
