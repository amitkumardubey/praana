import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuthorizeUrl, CodexManualPromptSuperseded } from "../src/oauth-codex.js";
import {
  createOAuthTextPrompt,
  formatOAuthManualPrompt,
  oauthManualPromptFits,
  OAuthUserCancelledError,
  resolveOAuthSelectSelection,
  runOAuthLoginWithUi,
  wrapUrlForDisplay,
} from "../src/ui/tui/oauth-login-ui.js";
import { resetOAuthProvidersForTests } from "../src/oauth.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

describe("wrapUrlForDisplay", () => {
  it("keeps short urls on one line", () => {
    expect(wrapUrlForDisplay("https://example.com/a", 72)).toEqual([
      "https://example.com/a",
    ]);
  });

  it("does not insert newlines into a long url", () => {
    // Hard wraps are real line breaks and break paste. The overlay soft-wraps
    // with wrapMode="char", so a long URL stays one copyable string.
    const url = "https://example.com/" + "a".repeat(100);
    expect(wrapUrlForDisplay(url, 40)).toEqual([url]);
  });
});

it("keeps a Codex authorize URL on one line that fits a 24x80 login overlay", () => {
  const url = buildAuthorizeUrl("A".repeat(43), "b".repeat(32));
  const prompt = "Paste the redirect URL or authorization code (or finish in your browser):";
  const context = [
    "Sign in to openai-codex",
    "",
    "Signs in with your ChatGPT account via the Codex CLI sign-in.",
    "",
    "Open this URL:",
    ...wrapUrlForDisplay(url),
    "",
    "If the browser did not open, copy the URL above into your browser.",
  ];
  const body = formatOAuthManualPrompt(context, prompt);
  expect(body.split("\n").includes(url)).toBe(true);
  expect(body.includes("\n\n")).toBe(false);
  expect(body).toContain("Signs in with your ChatGPT account via the Codex CLI sign-in.");
  expect(body).toContain(prompt);
  expect(oauthManualPromptFits(24, 80, body)).toBe(true);
});

it("keeps the auth URL visible and passes only the manual prompt cancellation signal", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-"));
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
    expect(opened).toEqual([status[0]!.find((line) => line.startsWith("https://"))]);
  } finally {
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps login going when the browser opener rejects", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-browser-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "ui-account" } })).toString("base64url")}.sig`;
  const callback = Promise.resolve("callback-code");
  resetOAuthProvidersForTests({
    fetch: (async () => Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 })) as typeof fetch,
    callbackServer: async () => ({ wait: () => callback, close() {} }),
  });
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: new AbortController().signal,
      showStatus() {},
      promptSelect: async () => "browser",
      promptText: async () => "unused",
    }, async () => { throw new Error("browser failed"); });
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
    expect(credential.accountId).toBe("ui-account");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps login going when the browser opener throws synchronously", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-browser-sync-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "ui-account" } })).toString("base64url")}.sig`;
  const callback = Promise.resolve("callback-code");
  resetOAuthProvidersForTests({
    fetch: (async () => Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 })) as typeof fetch,
    callbackServer: async () => ({ wait: () => callback, close() {} }),
  });
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: new AbortController().signal,
      showStatus() {},
      promptSelect: async () => "browser",
      promptText: async () => "unused",
    }, () => { throw new Error("browser failed"); });
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
    expect(credential.accountId).toBe("ui-account");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps device-code login going when the browser opener rejects", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-device-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "device-account" } })).toString("base64url")}.sig`;
  resetOAuthProvidersForTests({
    fetch: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/usercode")) {
        return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: 1 });
      }
      if (target.endsWith("/deviceauth/token")) {
        return Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" });
      }
      return Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 });
    }) as typeof fetch,
  });
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: new AbortController().signal,
      showStatus() {},
      promptSelect: async () => "device_code",
      promptText: async () => "unused",
    }, async () => { throw new Error("browser failed"); });
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
    expect(credential.accountId).toBe("device-account");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps device-code login going when the browser opener throws synchronously", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-device-sync-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "device-account" } })).toString("base64url")}.sig`;
  resetOAuthProvidersForTests({
    fetch: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/usercode")) {
        return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: 1 });
      }
      if (target.endsWith("/deviceauth/token")) {
        return Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" });
      }
      return Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 });
    }) as typeof fetch,
  });
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: new AbortController().signal,
      showStatus() {},
      promptSelect: async () => "device_code",
      promptText: async () => "unused",
    }, () => { throw new Error("browser failed"); });
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
    expect(credential.accountId).toBe("device-account");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("rejects an aborted OAuth text prompt with an AbortError carrying the reason", async () => {
  const outer = new AbortController();
  const reason = new Error("overlay closed");
  let submitted: ((value: string) => void) | undefined;
  const pending = createOAuthTextPrompt({
    signal: outer.signal,
    present: (submit) => { submitted = submit; },
  });
  expect(submitted).toBeTypeOf("function");
  outer.abort(reason);
  await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "overlay closed" });
  submitted?.("should-not-resolve");
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects immediately when the prompt signal is already aborted", async () => {
  const outer = new AbortController();
  outer.abort();
  const pending = createOAuthTextPrompt({
    signal: outer.signal,
    present: () => { throw new Error("prompt should not be shown"); },
  });
  await expect(pending).rejects.toMatchObject({
    name: "AbortError",
    message: "The operation was aborted.",
  });
});

it("rejects a dismissed manual prompt instead of hanging when paste is the only path", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-dismiss-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const OriginalAbortController = globalThis.AbortController;
  const created: AbortController[] = [];
  globalThis.AbortController = class extends OriginalAbortController {
    constructor() {
      super();
      created.push(this);
    }
  };
  const overall = new OriginalAbortController();
  resetOAuthProvidersForTests({
    fetch: (async () => { throw new Error("token endpoint should not be called"); }) as typeof fetch,
    callbackServer: async () => undefined,
  });
  try {
    const login = runOAuthLoginWithUi("openai-codex", {
      signal: overall.signal,
      showStatus: () => {},
      promptSelect: async () => "browser",
      promptText: async (_message, _placeholder, _context, signal) => {
        const manual = created.find((controller) => controller.signal === signal);
        expect(manual).toBeDefined();
        manual!.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    }, () => {});
    const result = await Promise.race([
      login.then(() => "resolved" as const, (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    if (result === "hung" || result === "resolved") {
      throw new Error(`login ${result}`);
    }
    expect(result).toBeInstanceOf(CodexManualPromptSuperseded);
    expect(overall.signal.aborted).toBe(false);
  } finally {
    overall.abort();
    globalThis.AbortController = OriginalAbortController;
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("completes Codex login when the callback wins and the manual prompt rejects", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-abort-"));
  const previousHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const overall = new AbortController();
  let finishCallback!: (value: string) => void;
  const callback = new Promise<string>((resolve) => { finishCallback = resolve; });
  const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "ui-account" } })).toString("base64url")}.sig`;
  resetOAuthProvidersForTests({
    fetch: (async () => Response.json({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 })) as typeof fetch,
    callbackServer: async () => ({ wait: () => callback, close() {} }),
  });
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const credential = await runOAuthLoginWithUi("openai-codex", {
      signal: overall.signal,
      showStatus: () => {},
      promptSelect: async () => "browser",
      promptText: async (_message, _placeholder, _context, signal) => {
        finishCallback("callback-code");
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(signal.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        });
      },
    }, () => {});
    expect(credential.accountId).toBe("ui-account");
    expect(overall.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

describe("OAuth select cancel", () => {
  it("undismissed select is a user cancel, not a failed login", () => {
    expect(resolveOAuthSelectSelection("device-flow")).toBe("device-flow");
    expect(() => resolveOAuthSelectSelection(undefined)).toThrow(
      OAuthUserCancelledError,
    );
    expect(() => resolveOAuthSelectSelection(undefined)).toThrow(/cancelled/);
  });
});

it("rejects an Esc abort of the Codex paste prompt with OAuthUserCancelledError", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-oauth-ui-esc-"));
  const previousHome = process.env.PRAANA_HOME;
  const previousBrowser = process.env.PRAANA_OPEN_BROWSER;
  process.env.PRAANA_HOME = home;
  process.env.PRAANA_OPEN_BROWSER = "0";
  resetCredentialStoreForTests();
  const overall = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  resetOAuthProvidersForTests({
    fetch: (async () => { throw new Error("token endpoint should not be called"); }) as typeof fetch,
    callbackServer: async () => ({ wait: () => new Promise<string>(() => {}), close() {} }),
  });
  try {
    const login = runOAuthLoginWithUi("openai-codex", {
      signal: overall.signal,
      showStatus() {},
      promptSelect: async () => "browser",
      promptText: (_message, _placeholder, _context, promptSignal) =>
        createOAuthTextPrompt({
          signal: overall.signal,
          promptSignal,
          present: () => {
            queueMicrotask(() => overall.abort(new OAuthUserCancelledError()));
          },
        }),
    }, () => {});
    const result = await Promise.race([
      login.then(() => "resolved" as const, (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    if (result === "hung" || result === "resolved") throw new Error(`login ${result}`);
    expect(result).toBeInstanceOf(OAuthUserCancelledError);
    expect(overall.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    overall.abort();
    process.off("unhandledRejection", onUnhandled);
    resetOAuthProvidersForTests();
    resetCredentialStoreForTests();
    if (previousHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previousHome;
    if (previousBrowser === undefined) delete process.env.PRAANA_OPEN_BROWSER;
    else process.env.PRAANA_OPEN_BROWSER = previousBrowser;
    rmSync(home, { recursive: true, force: true });
  }
});
