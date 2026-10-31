import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "./oauth.js";
import { startOAuthCallbackServer, type CallbackServerFactory, type OAuthCallbackServer } from "./oauth-callback-server.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const NOTICE = "Signs in with your ChatGPT account via the Codex CLI sign-in.";
const RELOGIN = "OpenAI Codex credential missing accountId; run /login openai-codex again";

type RandomBytes = (size: number) => Uint8Array;
export interface CodexOAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: RandomBytes;
  callbackServer?: CallbackServerFactory;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function generatePKCE(randomBytes: RandomBytes = cryptoRandomBytes): { verifier: string; challenge: string } {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(`${AUTH_BASE}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, scope: "openid profile email offline_access",
    redirect_uri: REDIRECT_URI, code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "praana",
  }).toString();
  return url.toString();
}

export function extractAccountId(token: string): string {
  let accountId: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error("Malformed JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    throw new Error("OpenAI Codex access token is not a valid JWT; run /login openai-codex again");
  }
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("OpenAI Codex access token missing chatgpt_account_id; run /login openai-codex again");
  }
  return accountId;
}

export function parseManualInput(input: string, expectedState: string): string {
  const value = input.trim();
  let code: string | null = value;
  let state: string | null = null;
  if (/^https?:\/\//i.test(value) || value.includes("code=") || value.includes("error=")) {
    const params = /^https?:\/\//i.test(value)
      ? new URL(value).searchParams : new URLSearchParams(value.replace(/^\?/, ""));
    state = params.get("state");
    if (state !== null && state !== expectedState) throw new Error("OpenAI Codex OAuth state mismatch");
    if (params.has("error")) throw new Error(`OpenAI Codex authorization failed: ${params.get("error_description") || params.get("error")}`);
    code = params.get("code");
  } else if (value.includes("#")) {
    const index = value.indexOf("#");
    code = value.slice(0, index);
    state = value.slice(index + 1);
  }
  if (state !== null && state !== expectedState) throw new Error("OpenAI Codex OAuth state mismatch");
  if (!code?.trim()) throw new Error("Missing OpenAI Codex authorization code");
  return code;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export function createOpenAICodexOAuth(deps: CodexOAuthDeps = {}): OAuthAuth {
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;
  const callbackServer = deps.callbackServer ?? startOAuthCallbackServer;
  const pause = deps.sleep ?? sleep;

  const tokenRequest = async (params: Record<string, string>, signal?: AbortSignal): Promise<OAuthCredential> => {
    const response = await request(`${AUTH_BASE}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: CLIENT_ID }), signal,
    });
    if (!response.ok) throw new Error(`OpenAI Codex token ${params.grant_type} failed (${response.status})`);
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== "string" || !data.access_token ||
        typeof data.refresh_token !== "string" || !data.refresh_token ||
        typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error("OpenAI Codex token response missing access_token, refresh_token or numeric expires_in");
    }
    return { type: "oauth", access: data.access_token, refresh: data.refresh_token,
      expires: now() + data.expires_in * 1000, accountId: extractAccountId(data.access_token) };
  };
  const exchange = (code: string, verifier: string, redirectUri: string, signal: AbortSignal) =>
    tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, signal);

  async function browserLogin(interaction: AuthInteraction): Promise<OAuthCredential> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("OpenAI Codex browser login timed out")), 10 * 60_000);
    const signal = interaction.signal ? AbortSignal.any([interaction.signal, timeout.signal]) : timeout.signal;
    const manualAbort = new AbortController();
    let callback: OAuthCallbackServer | undefined;
    try {
      signal.throwIfAborted();
      const { verifier, challenge } = generatePKCE(randomBytes);
      const state = Buffer.from(randomBytes(16)).toString("hex");
      callback = await callbackServer({ state, signal });
      interaction.notify({ type: "auth_url", url: buildAuthorizeUrl(challenge, state), instructions: NOTICE });
      if (!callback) interaction.notify({ type: "info", message: "Local callback unavailable (127.0.0.1:1455); paste the redirect URL or authorization code below." });
      const manual = async () => {
        try {
          return parseManualInput(await interaction.prompt({
            type: "manual_code", message: "Paste the redirect URL or authorization code (or finish in your browser):",
            signal: manualAbort.signal,
          }), state);
        } catch (error) {
          // Callback won and aborted only this prompt. Do not fail the login.
          if (manualAbort.signal.aborted && !signal.aborted) return await new Promise<string>(() => {});
          throw error;
        }
      };
      const code = await withSignal(callback ? Promise.race([callback.wait(), manual()]) : manual(), signal);
      manualAbort.abort();
      callback?.close();
      return await withSignal(exchange(code, verifier, REDIRECT_URI, signal), signal);
    } finally {
      clearTimeout(timer);
      manualAbort.abort();
      callback?.close();
    }
  }

  async function deviceLogin(interaction: AuthInteraction): Promise<OAuthCredential> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("OpenAI Codex device login timed out")), 15 * 60_000);
    const signal = interaction.signal ? AbortSignal.any([interaction.signal, timeout.signal]) : timeout.signal;
    const deadline = now() + 15 * 60_000;
    const post = async (path: string, body: Record<string, string>) => {
      signal.throwIfAborted();
      return withSignal(request(`${AUTH_BASE}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      }), signal);
    };
    try {
      const initial = await post("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
      if (initial.status === 404) throw new Error("OpenAI Codex device-code login unavailable; use browser login");
      if (!initial.ok) throw new Error(`OpenAI Codex device-code request failed (${initial.status})`);
      const data = await initial.json() as Record<string, unknown>;
      const interval = typeof data.interval === "string" ? Number(data.interval.trim()) : data.interval;
      if (typeof data.device_auth_id !== "string" || !data.device_auth_id || typeof data.user_code !== "string" || !data.user_code ||
          typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) throw new Error("Invalid OpenAI Codex device-code response");
      let intervalMs = Math.max(1000, Math.floor(interval * 1000));
      interaction.notify({ type: "info", message: NOTICE });
      interaction.notify({ type: "device_code", userCode: data.user_code, verificationUri: `${AUTH_BASE}/codex/device`, intervalSeconds: interval, expiresInSeconds: 900 });
      while (now() < deadline) {
        const response = await post("/api/accounts/deviceauth/token", { device_auth_id: data.device_auth_id, user_code: data.user_code });
        if (response.ok) {
          const result = await response.json() as Record<string, unknown>;
          if (typeof result.authorization_code !== "string" || !result.authorization_code || typeof result.code_verifier !== "string" || !result.code_verifier) throw new Error("Invalid OpenAI Codex device authorization response");
          return await withSignal(exchange(result.authorization_code, result.code_verifier, DEVICE_REDIRECT_URI, signal), signal);
        }
        if (response.status !== 403 && response.status !== 404) {
          let error: unknown;
          try {
            const result = await response.json() as { error?: string | { code?: string } };
            error = typeof result.error === "object" ? result.error?.code : result.error;
          } catch { /* Non-JSON failures are reported by status below. */ }
          if (error === "slow_down") intervalMs += 5000;
          else if (error !== "deviceauth_authorization_pending") throw new Error(`OpenAI Codex device authorization failed (${response.status})`);
        }
        const remaining = deadline - now();
        if (remaining > 0) await withSignal(pause(Math.min(intervalMs, remaining), signal), signal);
      }
      throw new Error("OpenAI Codex device login timed out");
    } finally { clearTimeout(timer); }
  }

  return {
    name: "OpenAI Codex",
    async login(interaction) {
      interaction.signal?.throwIfAborted();
      const method = await interaction.prompt({ type: "select", message: `${NOTICE}\nChoose a sign-in method:`, signal: interaction.signal, options: [
        { id: "browser", label: "Browser login (default)", description: "Local callback with paste fallback" },
        { id: "device_code", label: "Device-code login", description: "For SSH or headless environments" },
      ] });
      if (method === "browser") return browserLogin(interaction);
      if (method === "device_code") return deviceLogin(interaction);
      throw new Error("OpenAI Codex login cancelled");
    },
    async refresh(credential, signal) {
      if (typeof credential.accountId !== "string" || !credential.accountId.trim()) throw new Error(RELOGIN);
      return tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal);
    },
    async toAuth(credential) {
      if (typeof credential.accountId !== "string" || !credential.accountId.trim()) throw new Error(RELOGIN);
      return { apiKey: credential.access, headers: { "chatgpt-account-id": credential.accountId } };
    },
  };
}
