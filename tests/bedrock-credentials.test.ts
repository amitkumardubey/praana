import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasAmbientAwsCredentials,
  resolveBedrockBearerToken,
  isBedrockAvailable,
  getBedrockMissingCredentialsMessage,
} from "../src/bedrock/credentials.js";
import { setApiKey, resetCredentialStoreForTests } from "../src/credentials.js";
import { isProviderAvailable, getMissingKeyMessage } from "../src/llm.js";

const AWS_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "PRAANA_HOME",
] as const;

describe("bedrock credentials", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-bedrock-cred-"));
    for (const k of AWS_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRAANA_HOME = home;
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("detects ambient sources and bearer/store", () => {
    expect(hasAmbientAwsCredentials()).toBe(false);
    expect(isBedrockAvailable()).toBe(false);

    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    expect(resolveBedrockBearerToken()).toBe("tok");
    expect(isBedrockAvailable()).toBe(true);
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;

    setApiKey("amazon-bedrock", "stored-tok");
    expect(resolveBedrockBearerToken()).toBe("stored-tok");
    expect(isBedrockAvailable()).toBe(true);
    expect(isProviderAvailable("amazon-bedrock")).toBe(true);

    process.env.AWS_PROFILE = "dev";
    expect(hasAmbientAwsCredentials()).toBe(true);
  });

  it("missing message mentions API key and AWS credentials", () => {
    const msg = getBedrockMissingCredentialsMessage();
    expect(msg).toMatch(/Bedrock API key/i);
    expect(msg).toMatch(/AWS_/);
    expect(getMissingKeyMessage("amazon-bedrock")).toBe(msg);
  });
});
