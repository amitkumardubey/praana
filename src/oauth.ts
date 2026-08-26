// ============================================================
// PRAANA — Native OAuth Subsystem
// Standard OAuth 2.0 PKCE & Token Lifecycle Management
// ============================================================

import {
  getOAuthToken,
  setOAuthToken,
  type StoredOAuthCredential,
} from "./credentials.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";

/** Refresh when fewer than this many ms remain before expiry. */
const REFRESH_SKEW_MS = 60_000;

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

const pasteTokenAuth = (name: string, promptMessage: string): OAuthAuth => ({
  name,
  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    const code = await interaction.prompt({
      type: "secret",
      message: promptMessage,
    });
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

const providers: OAuthProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: pasteTokenAuth("Anthropic", "Paste your Anthropic API key or Claude Pro OAuth token:"),
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    oauth: pasteTokenAuth("OpenAI Codex", "Paste your ChatGPT / Codex access token:"),
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
  setOAuthToken(provider, toStored(creds));
  return getOAuthToken(provider)!;
}

export async function ensureFreshAccessToken(
  provider: string,
): Promise<string | null> {
  const auth = await resolveOAuthModelAuth(provider);
  return auth?.apiKey ?? null;
}

export async function resolveOAuthModelAuth(
  provider: string,
): Promise<ModelAuth | null> {
  const stored = getOAuthToken(provider);
  if (!stored) return null;

  const oauth = getOAuthAuth(provider);
  if (!oauth) return { apiKey: stored.access };

  let credential = toOAuthCredential(stored);
  if (stored.expires <= Date.now() + REFRESH_SKEW_MS) {
    credential = await oauth.refresh(credential);
    setOAuthToken(provider, toStored(credential, stored));
  }

  return oauth.toAuth(credential);
}

export function resetOAuthProvidersForTests(): void {
  // no-op for native providers
}
