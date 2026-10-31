import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runOAuthLoginWithUi, wrapUrlForDisplay } from "../src/ui/tui/oauth-login-ui.js";
import { resetOAuthProvidersForTests } from "../src/oauth.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

describe("wrapUrlForDisplay", () => {
  it("keeps short urls on one line", () => {
    expect(wrapUrlForDisplay("https://example.com/a", 72)).toEqual([
      "https://example.com/a",
    ]);
  });

  it("wraps long urls", () => {
    const url = "https://example.com/" + "a".repeat(100);
    const lines = wrapUrlForDisplay(url, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(url);
  });
});

it("keeps the auth URL visible and passes only the manual prompt cancellation signal", async () => {
  const scratch = join(homedir(), ".cache/codex-login-scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "oauth-ui-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const overall = new AbortController();
  const opened: string[] = [];
  const status: string[][] = [];
  let receivedSignal: AbortSignal | undefined;
  let finishCallback!: (value: string) => void;
  const callback = new Promise<string>((resolve) => { finishCallback = resolve; });
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "ui-account" } })).toString("base64url")}.sig`;
  resetOAuthProvidersForTests({
    fetch: (async () => Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 })) as typeof fetch,
    callbackServer: async () => ({ wait: () => callback, close() {} }),
  });
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: overall.signal,
      showStatus: (lines) => status.push(lines),
      promptSelect: async () => "browser",
      promptText: async (_message, _placeholder, context, signal) => {
        expect(context).toEqual(status[0]);
        expect(context?.join("")).toContain("originator=praana");
        expect(context?.join("")).toContain("Signs in with your ChatGPT account via the Codex CLI sign-in.");
        receivedSignal = signal;
        finishCallback("callback-code");
        return new Promise<string>((resolve) => signal?.addEventListener("abort", () => resolve(""), { once: true }));
      },
    }, (url) => { opened.push(url); });
    expect(credential.accountId).toBe("ui-account");
    expect(receivedSignal?.aborted).toBe(true);
    expect(overall.signal.aborted).toBe(false);
    expect(opened).toEqual([status[0]!.slice(5, -2).join("")]);
  } finally {
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
