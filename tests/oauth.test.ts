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
  resolveOAuthModelAuth,
} from "../src/oauth.js";
import { OAuthUserCancelledError } from "../src/ui/tui/oauth-login-ui.js";

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

  it("aborts the GitHub Copilot device-code poll sleep immediately", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      urls.push(target);
      if (target === "https://github.com/login/device/code") {
        return Response.json({
          device_code: "dc",
          user_code: "uc",
          verification_uri: "https://github.com/login/device",
          interval: 1,
        });
      }
      return Response.json({ error: "authorization_pending" });
    }) as typeof fetch;
    try {
      const started = Date.now();
      const pending = runOAuthLogin("github-copilot", {
        signal: controller.signal,
        notify() {},
        prompt: async () => { throw new Error("prompt should not run"); },
      });
      // Let the login reach the device-code poll sleep (interval >= 5s).
      await Bun.sleep(20);
      controller.abort(new OAuthUserCancelledError());
      await expect(pending).rejects.toBeInstanceOf(OAuthUserCancelledError);
      // The abortable sleep rejects immediately instead of sleeping out the
      // whole interval.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(urls).toEqual(["https://github.com/login/device/code"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("does not fail a non-expired legacy JWT, so the per-turn refresh warning does not fire", async () => {
    const access = `e30.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "legacy-account" },
    })).toString("base64url")}.sig`;
    let fetches = 0;
    resetOAuthProvidersForTests({
      fetch: (async () => { fetches += 1; throw new Error("refresh should not run"); }) as typeof fetch,
    });
    setOAuthToken("openai-codex", { access, refresh: access, expires: Date.now() + 3_600_000 });
    // turn.ts catches resolveOAuthModelAuth and warns "OAuth token refresh failed".
    const auth = await resolveOAuthModelAuth("openai-codex");
    expect(fetches).toBe(0);
    expect(auth).toEqual({ apiKey: access, headers: { "chatgpt-account-id": "legacy-account" } });
  });

  it("a cancelled paste prompt leaves the stored credential untouched", async () => {
    setOAuthToken("anthropic", { access: "keep-access", refresh: "keep-refresh", expires: 50_000 });
    const before = getOAuthToken("anthropic");
    const reason = new DOMException("The operation was aborted.", "AbortError");
    await expect(runOAuthLogin("anthropic", {
      notify() {},
      prompt: async () => { throw reason; },
    })).rejects.toBe(reason);
    expect(getOAuthToken("anthropic")).toEqual(before);
  });

  it.each(["", "   ", "\n\t"])("refuses a blank pasted token %j without replacing a stored credential", async (blank) => {
    setOAuthToken("anthropic", { access: "keep-access", refresh: "keep-refresh", expires: 50_000 });
    const before = getOAuthToken("anthropic");
    await expect(runOAuthLogin("anthropic", {
      notify() {},
      prompt: async () => blank,
    })).rejects.toThrow(/empty OAuth token/);
    expect(getOAuthToken("anthropic")).toEqual(before);
  });

  it("runOAuthLogin refuses a blank credential even when login itself returns one", async () => {
    setOAuthToken("anthropic", { access: "keep-access", refresh: "keep-refresh", expires: 50_000 });
    const before = getOAuthToken("anthropic");
    resetOAuthProvidersForTests({}, {
      anthropic: {
        name: "blank",
        async login() {
          return { type: "oauth", access: "  ", refresh: "", expires: 1 };
        },
        async refresh(credential) { return credential; },
        async toAuth() { return {}; },
      },
    });
    await expect(runOAuthLogin("anthropic", {
      notify() {},
      prompt: async () => { throw new Error("prompt should not run"); },
    })).rejects.toThrow(/empty OAuth token/);
    expect(getOAuthToken("anthropic")).toEqual(before);
  });
});
