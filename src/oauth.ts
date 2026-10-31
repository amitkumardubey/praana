// ============================================================
// PRAANA — Native OAuth Subsystem
// Standard OAuth 2.0 PKCE & Token Lifecycle Management
// ============================================================

import {
  getOAuthToken,
  readCachedOAuthIfUnchanged,
  readOAuthTokenFromDisk,
  releaseProviderRefreshLock,
  setOAuthToken,
  waitForProviderRefreshLock,
  withCredentialStoreLockSync,
  type StoredOAuthCredential,
} from "./credentials.js";
import { getAppLogger } from "./logger.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";
import { createOpenAICodexOAuth, type CodexOAuthDeps } from "./oauth-codex.js";

/** Refresh when fewer than this many ms remain before expiry. */
const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

const oauthRefreshInflight = new Map<string, Promise<ModelAuth | null>>();

export class OAuthRefreshError extends Error {
  readonly provider: string;

  constructor(provider: string, providerName: string, reason: string) {
    super(`${providerName} session expired and could not be refreshed: ${reason}. Run /login ${provider} again.`);
    this.name = "OAuthRefreshError";
    this.provider = provider;
  }
}

/** Another session still holds the refresh lock and the access token is already expired. */
export class OAuthRefreshBusyError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super("another PRAANA session is refreshing; try again");
    this.name = "OAuthRefreshBusyError";
    this.provider = provider;
  }
}

export const REFRESH_LOCK_WAIT_MS = 30_000;
let refreshLockWaitOverride: number | null = null;

export function setRefreshLockWaitMsForTests(ms: number): void {
  refreshLockWaitOverride = ms;
}

function refreshLockWaitMs(): number {
  return refreshLockWaitOverride ?? REFRESH_LOCK_WAIT_MS;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return reason;
    const err = new Error(reason.message);
    err.name = "AbortError";
    return err;
  }
  const err = new Error(typeof reason === "string" && reason ? reason : "The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function raceWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortError(signal));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function refreshFailureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Built-in OAuth provider ids. */
export const OAUTH_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
] as const;

export type PraanaOAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

export type AuthPrompt = {
  signal?: AbortSignal;
} & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | {
      type: "info";
      message: string;
      links?: readonly { url: string; label?: string }[];
    }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

export interface OAuthAuth {
  name: string;
  login(interaction: AuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export interface OAuthProviderInfo {
  id: string;
  name: string;
  oauth: OAuthAuth;
}

const EMPTY_OAUTH_TOKEN = "Refusing to store an empty OAuth token";

function assertStorableOAuthCredential(creds: OAuthCredential): void {
  if (typeof creds.access !== "string" || typeof creds.refresh !== "string" ||
      !creds.access.trim() || !creds.refresh.trim()) {
    throw new Error(EMPTY_OAUTH_TOKEN);
  }
}

const pasteTokenAuth = (name: string, promptMessage: string): OAuthAuth => ({
  name,
  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    const code = (await interaction.prompt({
      type: "secret",
      message: promptMessage,
    })).trim();
    if (!code) throw new Error(EMPTY_OAUTH_TOKEN);
    return {
      type: "oauth",
      access: code,
      refresh: code,
      expires: Date.now() + 3600 * 1000 * 24 * 30,
    };
  },
  async refresh(cred: OAuthCredential): Promise<OAuthCredential> {
    return cred;
  },
  async toAuth(cred: OAuthCredential): Promise<ModelAuth> {
    return { apiKey: cred.access };
  },
});

/** Public GitHub Copilot device-flow client id (same one used by Copilot.vim / copilot.lua). */
const COPILOT_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";

function copilotHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Editor-Version": "Praana/0.12.0",
    "Editor-Plugin-Version": "praana/0.12.0",
    "Copilot-Integration-Id": "vscode-chat",
  };
}

/**
 * Exchange a GitHub OAuth token for a Copilot API token.
 * If the input is already a Copilot token, GitHub rejects it and we return it as-is.
 */
export async function resolveCopilotModelAuth(
  githubOrCopilotToken: string,
  signal?: AbortSignal,
): Promise<ModelAuth> {
  const baseUrl = PROVIDER_REGISTRY["github-copilot"]?.baseUrl ?? "https://api.individual.githubcopilot.com";
  try {
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: {
        Authorization: `token ${githubOrCopilotToken}`,
        Accept: "application/json",
        "User-Agent": "praana",
      },
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data.token) {
        return {
          apiKey: data.token,
          headers: copilotHeaders(data.token),
          baseUrl,
        };
      }
    }
  } catch {
    // Fall through — caller may have pasted a Copilot API token directly.
  }
  return {
    apiKey: githubOrCopilotToken,
    headers: copilotHeaders(githubOrCopilotToken),
    baseUrl,
  };
}

const githubCopilotOAuth: OAuthAuth = {
  name: "GitHub Copilot",
  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    const res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "praana",
      },
      body: JSON.stringify({
        client_id: COPILOT_GITHUB_CLIENT_ID,
        scope: "read:user",
      }),
      signal: interaction.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub device login failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval?: number;
      expires_in?: number;
    };
    interaction.notify({
      type: "device_code",
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      intervalSeconds: data.interval,
      expiresInSeconds: data.expires_in,
    });

    let intervalMs = Math.max(5, data.interval ?? 5) * 1000;
    const deadline = Date.now() + (data.expires_in ?? 900) * 1000;

    while (Date.now() < deadline) {
      if (interaction.signal?.aborted) {
        throw new Error("OAuth login aborted");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "praana",
        },
        body: JSON.stringify({
          client_id: COPILOT_GITHUB_CLIENT_ID,
          device_code: data.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: interaction.signal,
      });
      const token = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (token.access_token) {
        return {
          type: "oauth",
          access: token.access_token,
          refresh: token.refresh_token || token.access_token,
          expires: Date.now() + (token.expires_in ?? 3600 * 24 * 365) * 1000,
        };
      }
      if (token.error === "authorization_pending") continue;
      if (token.error === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      throw new Error(token.error_description || token.error || "GitHub device login failed");
    }
    throw new Error("GitHub device login timed out");
  },
  async refresh(cred: OAuthCredential): Promise<OAuthCredential> {
    return cred;
  },
  async toAuth(cred: OAuthCredential): Promise<ModelAuth> {
    return resolveCopilotModelAuth(cred.access);
  },
};

const anthropicPaste = pasteTokenAuth(
  "Anthropic",
  "Paste your Anthropic API key or Claude Pro OAuth token:",
);

const providers: OAuthProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: anthropicPaste,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    oauth: createOpenAICodexOAuth(),
  },
  { id: "github-copilot", name: "GitHub Copilot", oauth: githubCopilotOAuth },
];

export function getOAuthAuth(provider: string): OAuthAuth | undefined {
  return providers.find((p) => p.id === provider)?.oauth;
}

export function isOAuthProvider(provider: string): boolean {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(provider);
}

export function supportsOAuthLogin(provider: string): boolean {
  return isOAuthProvider(provider);
}

export function isOAuthOnlyProvider(provider: string): boolean {
  return provider === "openai-codex" || provider === "github-copilot";
}

export function listOAuthProviders(): OAuthProviderInfo[] {
  return providers;
}

function toStored(
  creds: OAuthCredential,
  previous?: StoredOAuthCredential,
): StoredOAuthCredential {
  const entry: StoredOAuthCredential = {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    savedAt: Date.now(),
  };
  for (const [k, v] of Object.entries(creds)) {
    if (k === "type" || k === "access" || k === "refresh" || k === "expires") continue;
    entry[k] = v;
  }
  if (previous) {
    for (const [k, v] of Object.entries(previous)) {
      if (
        k === "type" ||
        k === "access" ||
        k === "refresh" ||
        k === "expires" ||
        k === "savedAt"
      ) {
        continue;
      }
      if (!(k in entry)) entry[k] = v;
    }
  }
  return entry;
}

function toOAuthCredential(stored: StoredOAuthCredential): OAuthCredential {
  const credential: OAuthCredential = {
    type: "oauth",
    access: stored.access,
    refresh: stored.refresh,
    expires: stored.expires,
  };
  for (const [k, v] of Object.entries(stored)) {
    if (k === "type" || k === "access" || k === "refresh" || k === "expires" || k === "savedAt") {
      continue;
    }
    credential[k] = v;
  }
  return credential;
}

export async function runOAuthLogin(
  provider: string,
  interaction: AuthInteraction,
): Promise<StoredOAuthCredential> {
  const oauth = getOAuthAuth(provider);
  if (!oauth) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }
  const creds = await oauth.login(interaction);
  assertStorableOAuthCredential(creds);
  setOAuthToken(provider, toStored(creds));
  return getOAuthToken(provider)!;
}

export async function ensureFreshAccessToken(
  provider: string,
): Promise<string | null> {
  const auth = await resolveOAuthModelAuth(provider);
  return auth?.apiKey ?? null;
}

function useCurrentAfterBusyWait(
  provider: string,
  oauth: OAuthAuth,
  latest: StoredOAuthCredential | undefined,
): Promise<ModelAuth | null> {
  if (!latest) return Promise.resolve(null);
  if (latest.expires > Date.now() + REFRESH_SKEW_MS) {
    return oauth.toAuth(toOAuthCredential(latest));
  }
  if (latest.expires > Date.now()) {
    getAppLogger().child("credentials").warn(
      "another PRAANA session is refreshing; using the current access token",
      { code: "UNKNOWN", details: { provider } },
    );
    return oauth.toAuth(toOAuthCredential(latest));
  }
  throw new OAuthRefreshBusyError(provider);
}

async function refreshOAuthCredential(
  provider: string,
  oauth: OAuthAuth,
): Promise<ModelAuth | null> {
  const acquired = await waitForProviderRefreshLock(provider, refreshLockWaitMs());
  if (!acquired) {
    const latest = withCredentialStoreLockSync(() => readOAuthTokenFromDisk(provider));
    return useCurrentAfterBusyWait(provider, oauth, latest);
  }
  try {
    const stored = withCredentialStoreLockSync(() => readOAuthTokenFromDisk(provider));
    if (!stored) return null;
    if (stored.expires > Date.now() + REFRESH_SKEW_MS) {
      return oauth.toAuth(toOAuthCredential(stored));
    }

    const refreshToken = stored.refresh;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error("OAuth token refresh timed out"));
    }, REFRESH_TIMEOUT_MS);
    timer.unref?.();
    try {
      let refreshed: OAuthCredential;
      try {
        refreshed = await oauth.refresh(toOAuthCredential(stored), timeout.signal);
      } catch (err) {
        const latest = withCredentialStoreLockSync(() => readOAuthTokenFromDisk(provider));
        if (!latest || latest.refresh !== refreshToken) {
          return latest ? oauth.toAuth(toOAuthCredential(latest)) : null;
        }
        if (latest.expires <= Date.now()) {
          throw new OAuthRefreshError(provider, oauth.name, refreshFailureReason(err));
        }
        getAppLogger().child("credentials").warn(
          `OAuth token refresh failed; using the current access token (${refreshFailureReason(err)})`,
          {
            cause: err instanceof Error ? err : new Error(refreshFailureReason(err)),
            code: "UNKNOWN",
            details: { provider },
          },
        );
        return oauth.toAuth(toOAuthCredential(latest));
      }

      // Persist before releasing the refresh lock, and only if this refresh token is still current.
      const committed = withCredentialStoreLockSync(() => {
        const latest = readOAuthTokenFromDisk(provider);
        if (!latest || latest.refresh !== refreshToken) return latest ?? null;
        setOAuthToken(provider, toStored(refreshed, latest));
        return readOAuthTokenFromDisk(provider) ?? null;
      });
      if (!committed) return null;
      return oauth.toAuth(toOAuthCredential(committed));
    } finally {
      clearTimeout(timer);
    }
  } finally {
    releaseProviderRefreshLock(provider);
  }
}

export async function resolveOAuthModelAuth(
  provider: string,
  signal?: AbortSignal,
): Promise<ModelAuth | null> {
  const oauth = getOAuthAuth(provider);
  if (!oauth) return null;

  const cached = readCachedOAuthIfUnchanged(provider);
  if (cached.unchanged) {
    if (!cached.token || cached.token.expires > Date.now() + REFRESH_SKEW_MS) {
      return cached.token ? oauth.toAuth(toOAuthCredential(cached.token)) : null;
    }
  }

  if (signal?.aborted) throw abortError(signal);

  let shared = oauthRefreshInflight.get(provider);
  if (!shared) {
    shared = (async () => {
      try {
        return await refreshOAuthCredential(provider, oauth);
      } catch (err) {
        if (err instanceof OAuthRefreshError || err instanceof OAuthRefreshBusyError || isAbortError(err)) {
          throw err;
        }
        const latest = withCredentialStoreLockSync(() => readOAuthTokenFromDisk(provider));
        if (!latest || latest.expires <= Date.now()) {
          throw new OAuthRefreshError(provider, oauth.name, refreshFailureReason(err));
        }
        getAppLogger().child("credentials").warn(
          `OAuth token refresh failed; using the current access token (${refreshFailureReason(err)})`,
          {
            cause: err instanceof Error ? err : new Error(refreshFailureReason(err)),
            code: "UNKNOWN",
            details: { provider },
          },
        );
        return oauth.toAuth(toOAuthCredential(latest));
      }
    })();
    oauthRefreshInflight.set(provider, shared);
    void shared.finally(() => {
      if (oauthRefreshInflight.get(provider) === shared) oauthRefreshInflight.delete(provider);
    }).catch(() => {});
  }
  return raceWithSignal(shared, signal);
}

export function resetOAuthProvidersForTests(
  codexDeps: CodexOAuthDeps = {},
  overrides: { anthropic?: OAuthAuth } = {},
): void {
  oauthRefreshInflight.clear();
  refreshLockWaitOverride = null;
  providers.find((provider) => provider.id === "openai-codex")!.oauth = createOpenAICodexOAuth(codexDeps);
  providers.find((provider) => provider.id === "anthropic")!.oauth = overrides.anthropic ?? anthropicPaste;
}
