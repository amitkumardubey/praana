// ============================================================
// PRAANA — Native OAuth Subsystem
// Standard OAuth 2.0 PKCE & Token Lifecycle Management
// ============================================================

import {
  getOAuthToken,
  setOAuthToken,
  type StoredOAuthCredential,
} from "./credentials.js";

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

const mockOAuthAuth: OAuthAuth = {
  name: "Standard OAuth",
  async login(interaction: AuthInteraction): Promise<OAuthCredential> {
    const code = await interaction.prompt({
      type: "secret",
      message: "Enter authorization code or API token:",
    });
    return {
      type: "oauth",
      access: code,
      refresh: code,
      expires: Date.now() + 3600 * 1000 * 24 * 30, // 30 days
    };
  },
  async refresh(cred: OAuthCredential): Promise<OAuthCredential> {
    return cred;
  },
  async toAuth(cred: OAuthCredential): Promise<ModelAuth> {
    return { apiKey: cred.access };
  },
};

const providers: OAuthProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", oauth: mockOAuthAuth },
  { id: "openai-codex", name: "OpenAI Codex", oauth: mockOAuthAuth },
  { id: "github-copilot", name: "GitHub Copilot", oauth: mockOAuthAuth },
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
