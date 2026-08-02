import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getOAuthToken,
  resetCredentialStoreForTests,
  setOAuthToken,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

const loginMock = mock(async () => ({
  type: "oauth" as const,
  access: "fresh-access",
  refresh: "fresh-refresh",
  expires: Date.now() + 3_600_000,
}));

const refreshMock = mock(async () => ({
  type: "oauth" as const,
  access: "rotated-access",
  refresh: "rotated-refresh",
  expires: Date.now() + 3_600_000,
}));

const toAuthMock = mock(async (credential: { access: string }) => ({
  apiKey: credential.access,
}));

const fakeOauth = {
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  login: loginMock,
  refresh: refreshMock,
  toAuth: toAuthMock,
};

mock.module("@earendil-works/pi-ai/providers/anthropic", () => ({
  anthropicProvider: () => ({ auth: { oauth: null } }),
}));
mock.module("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => ({ auth: { oauth: fakeOauth } }),
}));
mock.module("@earendil-works/pi-ai/providers/github-copilot", () => ({
  githubCopilotProvider: () => ({ auth: { oauth: null } }),
}));

const {
  isOAuthProvider,
  listOAuthProviders,
  runOAuthLogin,
  ensureFreshAccessToken,
  OAUTH_PROVIDER_IDS,
  resetOAuthProvidersForTests,
} = await import("../src/oauth.js");

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
    loginMock.mockClear();
    refreshMock.mockClear();
    toAuthMock.mockClear();
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
      prompt: async () => "",
    });
    expect(result.access).toBe("fresh-access");
    expect(getOAuthToken("openai-codex")?.access).toBe("fresh-access");
    expect(loginMock).toHaveBeenCalled();
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
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("ensureFreshAccessToken refreshes and persists when expired", async () => {
    setOAuthToken("openai-codex", {
      access: "stale-access",
      refresh: "refresh",
      expires: Date.now() - 1_000,
    });
    const token = await ensureFreshAccessToken("openai-codex");
    expect(token).toBe("rotated-access");
    expect(getOAuthToken("openai-codex")?.access).toBe("rotated-access");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("ensureFreshAccessToken returns null when no oauth credentials", async () => {
    expect(await ensureFreshAccessToken("openai-codex")).toBeNull();
  });
});
