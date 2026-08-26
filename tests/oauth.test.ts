import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getOAuthToken,
  resetCredentialStoreForTests,
  setOAuthToken,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import {
  isOAuthProvider,
  listOAuthProviders,
  runOAuthLogin,
  ensureFreshAccessToken,
  OAUTH_PROVIDER_IDS,
  resetOAuthProvidersForTests,
} from "../src/oauth.js";

describe("oauth facade", () => {
  let praanaHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-oauth-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetOAuthProvidersForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("lists built-in oauth providers", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("openai-codex");
    expect(isOAuthProvider("openai-codex")).toBe(true);
    expect(isOAuthProvider("openrouter")).toBe(false);
    expect(listOAuthProviders().some((p) => p.id === "openai-codex")).toBe(true);
  });

  it("runOAuthLogin persists the token bundle", async () => {
    const result = await runOAuthLogin("openai-codex", {
      notify: () => {},
      prompt: async () => "token-12345",
    });
    expect(result.access).toBe("token-12345");
    expect(getOAuthToken("openai-codex")?.access).toBe("token-12345");
  });

  it("runOAuthLogin rejects unknown providers", async () => {
    await expect(
      runOAuthLogin("not-a-provider", {
        notify: () => {},
        prompt: async () => "",
      }),
    ).rejects.toThrow(/Unknown OAuth provider/);
  });

  it("ensureFreshAccessToken returns cached access when not near expiry", async () => {
    setOAuthToken("openai-codex", {
      access: "cached-access",
      refresh: "refresh",
      expires: Date.now() + 3_600_000,
    });
    const token = await ensureFreshAccessToken("openai-codex");
    expect(token).toBe("cached-access");
  });

  it("ensureFreshAccessToken returns null when no oauth credentials", async () => {
    expect(await ensureFreshAccessToken("openai-codex")).toBeNull();
  });
});
