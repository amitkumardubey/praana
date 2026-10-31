import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
    const scratch = join(homedir(), ".cache/codex-login-scratch");
    mkdirSync(scratch, { recursive: true });
    praanaHome = mkdtempSync(join(scratch, "praana-oauth-"));
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

  it.each(["callback", "manual"])("persists a real Codex bundle when %s wins", async (winner) => {
    const access = `e30.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
    })).toString("base64url")}.sig`;
    const sequence: string[] = [];
    let manualSignal: AbortSignal | undefined;
    let closed = false;
    resetOAuthProvidersForTests({
      now: () => 1000,
      fetch: (async (_url, init) => {
        expect((init?.body as URLSearchParams).get("code")).toBe(`${winner}-code`);
        expect(closed).toBe(true);
        return Response.json({ access_token: access, refresh_token: "rotated-refresh", expires_in: 3600 });
      }) as typeof fetch,
      callbackServer: async () => ({
        wait: async () => winner === "callback" ? "callback-code" : new Promise<string>(() => {}),
        close: () => { closed = true; },
      }),
    });
    const result = await runOAuthLogin("openai-codex", {
      notify: (event) => { sequence.push(event.type); },
      prompt: async (prompt) => {
        sequence.push(prompt.type);
        if (prompt.type === "select") {
          expect(prompt.options[0]?.id).toBe("browser");
          expect(prompt.options.map((option) => option.id)).toEqual(["browser", "device_code"]);
          expect(prompt.message).toContain("Signs in with your ChatGPT account via the Codex CLI sign-in.");
          return "browser";
        }
        expect(prompt.type).toBe("manual_code");
        manualSignal = prompt.signal;
        return winner === "manual" ? "manual-code" : new Promise<string>((resolve) =>
          prompt.signal?.addEventListener("abort", () => resolve(""), { once: true }));
      },
    });
    expect(sequence).toEqual(["select", "auth_url", "manual_code"]);
    expect(manualSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ type: "oauth", access, refresh: "rotated-refresh", expires: 3_601_000, accountId: "synthetic-account" });
    expect(getOAuthToken("openai-codex")).toEqual(result);
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
      accountId: "synthetic-account",
    });
    const token = await ensureFreshAccessToken("openai-codex");
    expect(token).toBe("cached-access");
  });

  it("ensureFreshAccessToken returns null when no oauth credentials", async () => {
    expect(await ensureFreshAccessToken("openai-codex")).toBeNull();
  });
});
