import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bedrockNeedsApiKeyPrompt } from "../src/setup/logic.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

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

describe("bedrockNeedsApiKeyPrompt", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-setup-bedrock-"));
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

  it("is true without ambient credentials", () => {
    expect(bedrockNeedsApiKeyPrompt()).toBe(true);
  });

  it("is false when AWS_PROFILE is set", () => {
    process.env.AWS_PROFILE = "default";
    expect(bedrockNeedsApiKeyPrompt()).toBe(false);
  });
});
