import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest, Agent, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buildAuthorizeUrl, createOpenAICodexOAuth, extractAccountId, generatePKCE, parseManualInput } from "../src/oauth-codex.js";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "../src/oauth-callback-server.js";
import type { AuthEvent, AuthInteraction, OAuthCredential } from "../src/oauth.js";

const jwt = (id: unknown = "account-1") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
const tokenResponse = (id = "account-1", refresh = "refresh-new") => Response.json({ access_token: jwt(id), refresh_token: refresh, expires_in: 3600 });
const credential: OAuthCredential = { type: "oauth", access: jwt(), refresh: "refresh-old", expires: 0, accountId: "account-1" };
const fakeFetch = (fn: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  mock(async (url: string | URL | Request, init?: RequestInit) => fn(String(url), init!)) as unknown as typeof fetch;
const interaction = (method = "browser", input = "manual-code"): AuthInteraction => ({ notify() {}, prompt: async (p) => p.type === "select" ? method : input });

function fakeServer(bindError: boolean | string = false) {
  let handler!: (req: IncomingMessage, res: ServerResponse) => void;
  const server = new EventEmitter() as Server;
  const close = mock(() => server);
  const code = bindError === true ? "EADDRINUSE" : bindError || undefined;
  const listen = mock((port: number, host: string, ready: () => void) => {
    if (code) server.emit("error", Object.assign(new Error(code), { code }));
    else ready();
    return server;
  });
  server.close = close;
  server.listen = listen as unknown as Server["listen"];
  const factory = (fn: typeof handler) => { handler = fn; return server; };
  const send = (url: string, method = "GET", host = "127.0.0.1:1455") => {
    let status = 0;
    let headers: unknown;
    let html = "";
    handler({ url, method, headers: { host } } as IncomingMessage, {
      writeHead: (code: number, value: unknown) => { status = code; headers = value; },
      end: (value: string) => { html = value; },
    } as unknown as ServerResponse);
    return { status, headers, html };
  };
  return { factory, send, close, listen };
}

describe("Codex protocol helpers", () => {
  it("builds the exact PRAANA PKCE authorization request", () => {
    const { verifier, challenge } = generatePKCE((n) => new Uint8Array(n).fill(251));
    expect(verifier).toBe(Buffer.alloc(32, 251).toString("base64url"));
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(buildAuthorizeUrl(challenge, "state"));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: "code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", scope: "openid profile email offline_access", redirect_uri: "http://localhost:1455/auth/callback", code_challenge: challenge, code_challenge_method: "S256", state: "state", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "praana" });
  });
  it.each(["http://localhost:1455/auth/callback?code=abc&state=s", "abc#s", "?code=abc&state=s", "abc"])("parses manual input %s", (input) => {
    expect(parseManualInput(input, "s")).toBe("abc");
  });
  it.each(["http://localhost:1455/auth/callback?code=abc&state=bad", "abc#bad", "code=abc&state=bad"])("rejects mismatched state %s", (input) => {
    expect(() => parseManualInput(input, "s")).toThrow(/state mismatch/);
  });
  it("rejects empty input and provider errors", () => {
    expect(() => parseManualInput("", "s")).toThrow(/Missing/);
    expect(() => parseManualInput("?error=access_denied&state=s", "s")).toThrow(/access_denied/);
  });
  it("decodes base64url account claims", () => { expect(extractAccountId(jwt("acct-ü"))).toBe("acct-ü"); });
  it.each([jwt(""), jwt(null), "e30.e30.signature", "broken", "a.%%%.b"])("rejects missing or malformed account claims %s", (token) => {
    expect(() => extractAccountId(token)).toThrow(/run \/login openai-codex again/);
  });
});

describe("Codex callback listener", () => {
  it("validates route, method, state, missing code and duplicate callbacks", async () => {
    const fake = fakeServer();
    const callback = await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, fake.factory);
    expect(fake.listen.mock.calls[0]?.slice(0, 2)).toEqual([1455, "127.0.0.1"]);
    expect(fake.send("/wrong").status).toBe(404);
    expect(fake.send("/auth/callback?state=s&code=x", "POST").status).toBe(404);
    expect(fake.send("/auth/callback?state=no&code=x").status).toBe(400);
    expect(fake.send("/auth/callback?state=s").status).toBe(400);
    const response = fake.send("/auth/callback?state=s&code=x");
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    expect(response.html).toContain("Authorization received; return to PRAANA.");
    expect(response.html).not.toContain("successful");
    expect(await callback!.wait()).toBe("x");
    expect(fake.send("/auth/callback?state=s&code=y").status).toBe(409);
    callback!.close();
    expect(fake.close).toHaveBeenCalled();
  });
  it("ends the wait on provider error and escapes HTML", async () => {
    const fake = fakeServer();
    const callback = await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, fake.factory);
    const response = fake.send("/auth/callback?state=s&error=denied&error_description=%3Cscript%3E%26%22%27");
    expect(response.status).toBe(400);
    expect(response.html).toContain("&lt;script&gt;&amp;&quot;&#39;");
    expect(response.html).not.toContain("<script>");
    await expect(callback!.wait()).rejects.toThrow(/authorization failed/);
    callback!.close();
  });
  it("answers 400 for a malformed request target and keeps listening", async () => {
    const fake = fakeServer();
    const callback = await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, fake.factory);
    expect(fake.send("//").status).toBe(400);
    expect(fake.send("/auth/callback?state=s&code=still-up").status).toBe(200);
    expect(await callback!.wait()).toBe("still-up");
    callback!.close();
  });
  it("rejects a Host header other than the loopback callback", async () => {
    const fake = fakeServer();
    const callback = await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, fake.factory);
    expect(fake.send("/auth/callback?state=s&code=x", "GET", "evil.example:1455").status).toBe(400);
    expect(fake.send("/auth/callback?state=s&code=x", "GET", "localhost:80").status).toBe(400);
    expect(fake.send("/auth/callback?state=s&code=x", "GET", "localhost:1455").status).toBe(200);
    expect(await callback!.wait()).toBe("x");
    callback!.close();
  });
  it("surfaces bind errors other than EADDRINUSE", async () => {
    const denied = fakeServer("EACCES");
    await expect(startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, denied.factory))
      .rejects.toMatchObject({ code: "EACCES" });
    expect(denied.close).toHaveBeenCalled();
  });
  it("releases port 1455 immediately after close when the client used keep-alive", async () => {
    const callback = await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal });
    expect(callback).toBeDefined();
    const agent = new Agent({ keepAlive: true });
    try {
      const response = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: 1455,
          path: "/auth/callback?code=abc&state=s",
          headers: { Host: "127.0.0.1:1455", Connection: "keep-alive" },
          agent,
        }, (res) => {
          res.resume();
          res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            connection: typeof res.headers.connection === "string" ? res.headers.connection : undefined,
          }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(response.status).toBe(200);
      expect(response.connection).toBe("close");
      callback!.close();
      const again = await startOAuthCallbackServer({ state: "s2", signal: new AbortController().signal });
      expect(again).toBeDefined();
      again!.close();
    } finally {
      agent.destroy();
      callback?.close();
    }
  });
  it("closes on abort and falls back when the port is occupied", async () => {
    const fake = fakeServer();
    const abort = new AbortController();
    const callback = await startOAuthCallbackServer({ state: "s", signal: abort.signal }, fake.factory);
    abort.abort();
    await expect(callback!.wait()).rejects.toThrow(/cancelled/);
    expect(fake.close).toHaveBeenCalledTimes(1);
    const occupied = fakeServer(true);
    expect(await startOAuthCallbackServer({ state: "s", signal: new AbortController().signal }, occupied.factory)).toBeUndefined();
    expect(occupied.close).toHaveBeenCalledTimes(1);
  });
});

describe("Codex browser exchange and refresh", () => {
  it("uses the manual fallback message when the callback port is in use", async () => {
    const occupied = fakeServer(true);
    const notices: string[] = [];
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => tokenResponse()),
      callbackServer: (options) => startOAuthCallbackServer(options, occupied.factory),
    });
    const cred = await oauth.login({
      notify: (event) => { if (event.type === "info") notices.push(event.message); },
      prompt: async (prompt) => prompt.type === "select" ? "browser" : "manual-code",
    });
    expect(cred.accountId).toBe("account-1");
    expect(notices.some((message) => message.includes("callback unavailable"))).toBe(true);
    expect(notices.some((message) => message.includes("EADDRINUSE"))).toBe(false);
  });
  it("reports the error code and still accepts a paste when bind fails", async () => {
    const denied = fakeServer("EACCES");
    const notices: string[] = [];
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => tokenResponse()),
      callbackServer: (options) => startOAuthCallbackServer(options, denied.factory),
    });
    const cred = await oauth.login({
      notify: (event) => { if (event.type === "info") notices.push(event.message); },
      prompt: async (prompt) => prompt.type === "select" ? "browser" : "manual-code",
    });
    expect(cred.accountId).toBe("account-1");
    expect(notices.some((message) => message.includes("EACCES"))).toBe(true);
  });
  it("exchanges the manual code with PKCE and reports manual-only fallback", async () => {
    const events: AuthEvent[] = [];
    const request = fakeFetch((url, init) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ grant_type: "authorization_code", code: "manual-code", code_verifier: Buffer.alloc(32, 7).toString("base64url"), redirect_uri: "http://localhost:1455/auth/callback", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      return tokenResponse();
    });
    const oauth = createOpenAICodexOAuth({ fetch: request, now: () => 1000, randomBytes: (n) => new Uint8Array(n).fill(7), callbackServer: async () => undefined });
    const cred = await oauth.login({ ...interaction(), notify: (e) => events.push(e) });
    expect(cred).toEqual({ type: "oauth", access: jwt(), refresh: "refresh-new", expires: 3_601_000, accountId: "account-1" });
    expect(await oauth.toAuth(cred)).toEqual({ apiKey: jwt(), headers: { "chatgpt-account-id": "account-1" } });
    expect(events.some((e) => e.type === "info" && e.message.includes("callback unavailable"))).toBe(true);
    const urlEvent = events.find((e) => e.type === "auth_url");
    expect(urlEvent?.type === "auth_url" && new URL(urlEvent.url).searchParams.get("state")).toBe("07".repeat(16));
  });
  it("rotates refresh token, expiry and account id", async () => {
    const oauth = createOpenAICodexOAuth({ now: () => 5000, fetch: fakeFetch((_, init) => {
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-old", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      return tokenResponse("account-2", "rotated");
    }) });
    expect(await oauth.refresh(credential)).toEqual({ type: "oauth", access: jwt("account-2"), refresh: "rotated", expires: 3_605_000, accountId: "account-2" });
  });
  it.each([
    { access_token: jwt(), expires_in: 3600 },
    { access_token: jwt(), refresh_token: "r", expires_in: "3600" },
    { access_token: "e30.e30.sig", refresh_token: "r", expires_in: 3600 },
  ])("rejects invalid token bundles on both login and refresh", async (data) => {
    const oauth = createOpenAICodexOAuth({ callbackServer: async () => undefined, fetch: fakeFetch(() => Response.json(data)) });
    await expect(oauth.login(interaction())).rejects.toThrow(/missing/);
    await expect(oauth.refresh(credential)).rejects.toThrow(/missing/);
  });
  it("uses a legacy JWT account id for toAuth and re-login only when refresh is required", async () => {
    const request = fakeFetch(() => { throw new Error("unexpected fetch"); });
    const oauth = createOpenAICodexOAuth({ fetch: request });
    const legacy = { type: "oauth" as const, access: jwt("legacy-account"), refresh: "refresh-old", expires: 0 };
    expect(await oauth.toAuth(legacy)).toEqual({ apiKey: legacy.access, headers: { "chatgpt-account-id": "legacy-account" } });
    await expect(oauth.refresh(legacy)).rejects.toThrow(/run \/login openai-codex again/);
    const pasted = { ...credential, refresh: credential.access };
    await expect(oauth.refresh(pasted)).rejects.toThrow(/run \/login openai-codex again/);
    expect(request).not.toHaveBeenCalled();
  });
  it("requires re-login for an opaque legacy token", async () => {
    const request = fakeFetch(() => { throw new Error("unexpected fetch"); });
    const oauth = createOpenAICodexOAuth({ fetch: request });
    const opaque = { type: "oauth" as const, access: "opaque-token", refresh: "opaque-token", expires: 0 };
    await expect(oauth.toAuth(opaque)).rejects.toThrow(/run \/login openai-codex again/);
    await expect(oauth.refresh(opaque)).rejects.toThrow(/run \/login openai-codex again/);
    expect(request).not.toHaveBeenCalled();
  });
  it("refreshes a legacy JWT only by asking the user to sign in again, without a token request", async () => {
    const request = fakeFetch(() => { throw new Error("unexpected fetch"); });
    const oauth = createOpenAICodexOAuth({ fetch: request });
    const old = { ...credential, accountId: undefined };
    expect(await oauth.toAuth(old)).toEqual({ apiKey: old.access, headers: { "chatgpt-account-id": "account-1" } });
    await expect(oauth.refresh(old)).rejects.toThrow(/run \/login openai-codex again/);
    expect(request).not.toHaveBeenCalled();
  });
  it("re-prompts after an invalid manual paste, then exchanges a valid code", async () => {
    const notices: string[] = [];
    const inputs = ["http://localhost:1455/auth/callback?code=abc&state=typo", "good-code"];
    const oauth = createOpenAICodexOAuth({
      now: () => 1000,
      randomBytes: (n) => new Uint8Array(n).fill(7),
      fetch: fakeFetch((_url, init) => {
        expect((init.body as URLSearchParams).get("code")).toBe("good-code");
        return tokenResponse();
      }),
      callbackServer: async () => ({ wait: () => new Promise<string>(() => {}), close() {} }),
    });
    const cred = await oauth.login({
      notify: (event) => { if (event.type === "info" || event.type === "progress") notices.push(event.message); },
      prompt: async (prompt) => prompt.type === "select" ? "browser" : inputs.shift()!,
    });
    expect(cred.accountId).toBe("account-1");
    expect(inputs).toEqual([]);
    expect(notices.some((message) => message.includes("state mismatch"))).toBe(true);
  });

  it("re-prompts the same way when there is no callback server", async () => {
    const notices: string[] = [];
    const inputs = ["", "manual-code"];
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => tokenResponse()),
      callbackServer: async () => undefined,
    });
    const cred = await oauth.login({
      notify: (event) => { if (event.type === "info" || event.type === "progress") notices.push(event.message); },
      prompt: async (prompt) => prompt.type === "select" ? "browser" : inputs.shift()!,
    });
    expect(cred.accountId).toBe("account-1");
    expect(notices.some((message) => message.includes("Missing"))).toBe(true);
    expect(notices.some((message) => message.includes("callback unavailable"))).toBe(true);
  });

  it("keeps prompting for bad pastes while the callback listener is alive", async () => {
    const notices: string[] = [];
    const messages: string[] = [];
    const inputs = [...Array.from({ length: 6 }, () => "code=abc&state=bad"), "good-code"];
    const oauth = createOpenAICodexOAuth({
      now: () => 1000,
      randomBytes: (n) => new Uint8Array(n).fill(7),
      fetch: fakeFetch((_url, init) => {
        expect((init.body as URLSearchParams).get("code")).toBe("good-code");
        return tokenResponse();
      }),
      callbackServer: async () => ({ wait: () => new Promise<string>(() => {}), close() {} }),
    });
    const cred = await oauth.login({
      notify: (event) => { if (event.type === "info") notices.push(event.message); },
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        messages.push(prompt.message);
        return inputs.shift()!;
      },
    });
    expect(cred.accountId).toBe("account-1");
    expect(messages).toHaveLength(7);
    expect(messages.every((message) => message.includes("or finish in your browser"))).toBe(true);
    expect(notices.filter((message) => message.includes("state mismatch"))).toHaveLength(6);
  });

  it("caps manual-only pastes at five and does not mention the browser", async () => {
    const messages: string[] = [];
    const notices: string[] = [];
    let prompts = 0;
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => { throw new Error("token endpoint should not be called"); }),
      callbackServer: async () => undefined,
    });
    await expect(oauth.login({
      notify: (event) => { if (event.type === "info") notices.push(event.message); },
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        prompts++;
        messages.push(prompt.message);
        return "code=abc&state=bad";
      },
    })).rejects.toThrow(/state mismatch/);
    expect(prompts).toBe(5);
    expect(messages.every((message) => message.includes("or finish in your browser"))).toBe(false);
    expect(messages.every((message) => message.startsWith("Paste the redirect URL or authorization code"))).toBe(true);
    expect(notices.filter((message) => message.includes("state mismatch"))).toHaveLength(5);
  });

  it("a cancelled paste still ends login while the listener is alive", async () => {
    const reason = new Error("cancelled");
    let prompts = 0;
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => { throw new Error("token endpoint should not be called"); }),
      callbackServer: async () => ({ wait: () => new Promise<string>(() => {}), close() {} }),
    });
    await expect(oauth.login({
      notify() {},
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        prompts++;
        if (prompts === 1) return "code=abc&state=bad";
        throw reason;
      },
    })).rejects.toBe(reason);
    expect(prompts).toBe(2);
  });

  it("fails after five invalid manual pastes when paste is the only path", async () => {
    let prompts = 0;
    const notices: string[] = [];
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => { throw new Error("token endpoint should not be called"); }),
      callbackServer: async () => undefined,
    });
    await expect(oauth.login({
      notify: (event) => { if (event.type === "info" || event.type === "progress") notices.push(event.message); },
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        prompts++;
        return "code=abc&state=bad";
      },
    })).rejects.toThrow(/state mismatch/);
    expect(prompts).toBe(5);
    expect(notices.filter((message) => message.includes("state mismatch"))).toHaveLength(5);
  });

  it("still completes when the callback wins while a manual prompt is pending", async () => {
    let manualSignal: AbortSignal | undefined;
    let finish!: (code: string) => void;
    const callback = new Promise<string>((resolve) => { finish = resolve; });
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch((_url, init) => {
        expect((init.body as URLSearchParams).get("code")).toBe("from-callback");
        return tokenResponse();
      }),
      callbackServer: async () => ({ wait: () => callback, close() {} }),
    });
    const cred = await oauth.login({
      notify() {},
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        manualSignal = prompt.signal;
        finish("from-callback");
        return new Promise<string>(() => {});
      },
    });
    expect(cred.accountId).toBe("account-1");
    expect(manualSignal?.aborted).toBe(true);
  });

  it("stops retrying when the user aborts after a bad paste", async () => {
    const abort = new AbortController();
    let prompts = 0;
    const oauth = createOpenAICodexOAuth({
      fetch: fakeFetch(() => { throw new Error("token endpoint should not be called"); }),
      callbackServer: async () => ({ wait: () => new Promise<string>(() => {}), close() {} }),
    });
    await expect(oauth.login({
      signal: abort.signal,
      notify() {},
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        prompts++;
        if (prompts === 1) return "code=abc&state=bad";
        abort.abort(new Error("cancelled"));
        throw abort.signal.reason;
      },
    })).rejects.toThrow(/cancelled/);
    expect(prompts).toBe(2);
  });

  it.each(["abort", "exchange failure"])("closes listener and cancels manual prompt on %s", async (mode) => {
    const controller = new AbortController();
    let manualSignal: AbortSignal | undefined;
    let callbackSignal: AbortSignal | undefined;
    const close = mock(() => {});
    const oauth = createOpenAICodexOAuth({ fetch: fakeFetch(() => new Response("", { status: 400 })), callbackServer: async ({ signal }) => {
      callbackSignal = signal;
      return { close, wait: async () => mode === "abort" ? new Promise<string>(() => {}) : "code" };
    } });
    const pending = oauth.login({ signal: controller.signal, notify() {}, prompt: async (p) => {
      if (p.type === "select") return "browser";
      manualSignal = p.signal;
      if (mode === "abort") controller.abort(new Error("cancelled"));
      return new Promise<string>(() => {});
    } });
    await expect(pending).rejects.toThrow(mode === "abort" ? /cancelled/ : /failed/);
    expect(close).toHaveBeenCalled();
    expect(manualSignal?.aborted).toBe(true);
    if (mode === "abort") expect(callbackSignal?.aborted).toBe(true);
  });
});

describe("Codex device authorization", () => {
  it("honours pending variants, slow_down, interval and the device exchange redirect", async () => {
    let clock = 0;
    const waits: number[] = [];
    const events: AuthEvent[] = [];
    const polls = [new Response("", { status: 403 }), new Response("", { status: 404 }), Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 400 }), Response.json({ error: "slow_down" }, { status: 429 }), Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" })];
    const oauth = createOpenAICodexOAuth({ now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; }, fetch: fakeFetch((url, init) => {
      if (url.endsWith("/usercode")) {
        expect(JSON.parse(String(init.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
        return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "2" });
      }
      if (url.endsWith("/deviceauth/token")) {
        expect(JSON.parse(String(init.body))).toEqual({ device_auth_id: "device", user_code: "ABCD" });
        return polls.shift()!;
      }
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ grant_type: "authorization_code", code: "device-code", code_verifier: "device-verifier", redirect_uri: "https://auth.openai.com/deviceauth/callback", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      return tokenResponse();
    }) });
    expect((await oauth.login({ ...interaction("device_code"), notify: (e) => events.push(e) })).accountId).toBe("account-1");
    expect(waits).toEqual([2000, 2000, 2000, 7000]);
    expect(events).toContainEqual({ type: "device_code", userCode: "ABCD", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 2, expiresInSeconds: 900 });
  });
  it("cancels or drains device-poll bodies, including when polling is aborted", async () => {
    const tracked: Array<{ label: string; cancelled: boolean; drained: boolean }> = [];
    const track = (label: string, status: number, json?: unknown) => {
      const entry = { label, cancelled: false, drained: false };
      tracked.push(entry);
      const payload = json === undefined ? undefined : JSON.stringify(json);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (payload === undefined) return;
          entry.drained = true;
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
        cancel() { entry.cancelled = true; },
      }), { status, headers: payload === undefined ? {} : { "Content-Type": "application/json" } });
    };
    let clock = 0;
    const polls = [
      track("forbidden", 403),
      track("missing", 404),
      track("pending", 400, { error: { code: "deviceauth_authorization_pending" } }),
      track("slow", 429, { error: "slow_down" }),
      track("ready", 200, { authorization_code: "device-code", code_verifier: "device-verifier" }),
    ];
    const oauth = createOpenAICodexOAuth({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetch: fakeFetch((url) => {
        if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: 1 });
        if (url.endsWith("/oauth/token")) return tokenResponse();
        return polls.shift()!;
      }),
    });
    expect((await oauth.login(interaction("device_code"))).accountId).toBe("account-1");
    for (const entry of tracked) {
      if (entry.label === "ready") continue;
      expect(entry.cancelled || entry.drained, entry.label).toBe(true);
    }
    expect(tracked.find((entry) => entry.label === "forbidden")?.cancelled).toBe(true);
    expect(tracked.find((entry) => entry.label === "missing")?.cancelled).toBe(true);

    tracked.length = 0;
    const abort = new AbortController();
    const aborted = createOpenAICodexOAuth({
      now: () => 0,
      sleep: async () => { abort.abort(new Error("cancelled")); },
      fetch: fakeFetch((url) => url.endsWith("/usercode")
        ? Response.json({ device_auth_id: "device", user_code: "ABCD", interval: 1 })
        : track("aborted", 403)),
    });
    await expect(aborted.login({ ...interaction("device_code"), signal: abort.signal })).rejects.toThrow(/cancelled/);
    expect(tracked.find((entry) => entry.label === "aborted")?.cancelled).toBe(true);
  });
  it.each(["timeout", "abort", "404", "denied"])("handles device %s", async (mode) => {
    let clock = 0;
    const abort = new AbortController();
    const oauth = createOpenAICodexOAuth({ now: () => clock, sleep: async (ms) => {
      clock += ms;
      if (mode === "abort") abort.abort(new Error("cancelled"));
    }, fetch: fakeFetch((url) => {
      if (url.endsWith("/usercode")) return mode === "404" ? new Response("", { status: 404 }) : Response.json({ device_auth_id: "d", user_code: "u", interval: 600 });
      return mode === "denied" ? Response.json({ error: "access_denied" }, { status: 400 }) : new Response("", { status: 403 });
    }) });
    await expect(oauth.login({ ...interaction("device_code"), signal: abort.signal })).rejects.toThrow(mode === "404" ? /use browser login/ : mode === "timeout" ? /timed out/ : mode === "abort" ? /cancelled/ : /failed/);
    if (mode === "timeout") expect(clock).toBe(900_000);
  });
});

describe("Codex device poll transient retries", () => {
  function deviceOauth(options: {
    polls: Array<Response | (() => Response)>;
    interval?: number;
    clock?: { value: number };
    waits?: number[];
    usercode?: Response;
  }) {
    const clock = options.clock ?? { value: 0 };
    const waits = options.waits ?? [];
    const polls = [...options.polls];
    return createOpenAICodexOAuth({
      now: () => clock.value,
      sleep: async (ms) => { waits.push(ms); clock.value += ms; },
      fetch: fakeFetch((url) => {
        if (url.endsWith("/usercode")) {
          return options.usercode ?? Response.json({ device_auth_id: "device", user_code: "ABCD", interval: options.interval ?? 2 });
        }
        if (url.endsWith("/deviceauth/token")) {
          const next = polls[0];
          if (typeof next === "function") return next();
          return polls.shift()!;
        }
        return tokenResponse();
      }),
    });
  }

  it.each([502, 503, 504])("retries HTTP %s and then succeeds", async (status) => {
    const waits: number[] = [];
    const oauth = deviceOauth({
      waits,
      polls: [
        new Response("upstream", { status }),
        Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" }),
      ],
    });
    expect((await oauth.login(interaction("device_code"))).accountId).toBe("account-1");
    expect(waits).toEqual([2000]);
  });

  it("retries a non-JSON 502 body", async () => {
    const waits: number[] = [];
    const oauth = deviceOauth({
      waits,
      polls: [
        new Response("not-json", { status: 502 }),
        Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" }),
      ],
    });
    expect((await oauth.login(interaction("device_code"))).accountId).toBe("account-1");
    expect(waits).toEqual([2000]);
  });

  it("honours Retry-After seconds on 429 and caps them at 30s", async () => {
    const waits: number[] = [];
    const oauth = deviceOauth({
      waits,
      polls: [
        new Response("", { status: 429, headers: { "Retry-After": "5" } }),
        new Response("later", { status: 429, headers: { "Retry-After": "45" } }),
        Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" }),
      ],
    });
    expect((await oauth.login(interaction("device_code"))).accountId).toBe("account-1");
    expect(waits).toEqual([5000, 30_000]);
  });

  it("keeps an unexpected 400 fatal", async () => {
    const oauth = deviceOauth({
      polls: [Response.json({ error: "access_denied" }, { status: 400 })],
    });
    await expect(oauth.login(interaction("device_code"))).rejects.toThrow(/device authorization failed \(400\)/);
  });

  it("still ends the login at the 15 minute deadline while 502s continue", async () => {
    const clock = { value: 0 };
    const oauth = deviceOauth({
      clock,
      interval: 600,
      polls: [() => new Response("upstream", { status: 502 })],
    });
    await expect(oauth.login(interaction("device_code"))).rejects.toThrow(/timed out/);
    expect(clock.value).toBe(900_000);
  });

  it("cancels the usercode body when that request is not ok", async () => {
    let cancelled = false;
    const usercode = new Response(new ReadableStream<Uint8Array>({
      pull() {},
      cancel() { cancelled = true; },
    }), { status: 500 });
    const oauth = deviceOauth({ polls: [], usercode });
    await expect(oauth.login(interaction("device_code"))).rejects.toThrow(/device-code request failed \(500\)/);
    expect(cancelled).toBe(true);
  });
});
