import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  resolveBedrockRegion,
  setBedrockConfigRegion,
  resetBedrockConfigRegionForTests,
} from "../src/bedrock/region.js";

describe("resolveBedrockRegion", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetBedrockConfigRegionForTests();
  });

  afterEach(() => {
    resetBedrockConfigRegionForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers config.region over env", () => {
    process.env.AWS_REGION = "eu-west-1";
    expect(resolveBedrockRegion({ region: "us-west-2" })).toBe("us-west-2");
  });

  it("uses module config region from loadConfig when no explicit arg", () => {
    setBedrockConfigRegion("ap-northeast-1");
    process.env.AWS_REGION = "eu-west-1";
    expect(resolveBedrockRegion()).toBe("ap-northeast-1");
  });

  it("uses AWS_REGION then AWS_DEFAULT_REGION then us-east-1", () => {
    expect(resolveBedrockRegion()).toBe("us-east-1");
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    expect(resolveBedrockRegion()).toBe("ap-southeast-1");
    process.env.AWS_REGION = "eu-central-1";
    expect(resolveBedrockRegion()).toBe("eu-central-1");
  });

  it("ignores blank config.region", () => {
    process.env.AWS_REGION = "us-east-2";
    expect(resolveBedrockRegion({ region: "  " })).toBe("us-east-2");
  });
});
