import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProvider } from "../src/llm.js";
import { setApiKey, resetCredentialStoreForTests } from "../src/credentials.js";
import { resetBedrockConfigRegionForTests } from "../src/bedrock/region.js";

describe("bedrock __piOptions", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-bedrock-opts-"));
    for (const k of [
      "PRAANA_HOME",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_BEARER_TOKEN_BEDROCK",
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
    resetBedrockConfigRegionForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetBedrockConfigRegionForTests();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sets region and bearerToken, not apiKey", () => {
    setApiKey("amazon-bedrock", "stored-tok");
    const build = createProvider({
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      region: "eu-west-1",
    });
    const model = build("us.anthropic.claude-sonnet-4-20250514-v1:0") as {
      __piOptions?: Record<string, unknown>;
    };
    expect(model.__piOptions?.region).toBe("eu-west-1");
    expect(model.__piOptions?.bearerToken).toBe("stored-tok");
    expect(model.__piOptions?.apiKey).toBeUndefined();
  });
});
