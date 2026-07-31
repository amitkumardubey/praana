// ============================================================
// PRAANA — OAuth facade over pi-ai provider OAuthAuth
// ============================================================
//
// Uses the 0.83+ AuthInteraction API exposed via provider factories.
// Credential persistence lives in credentials.ts.

import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import {
  getOAuthToken,
  setOAuthToken,
  type StoredOAuthCredential,
} from "./credentials.js";

/** Refresh when fewer than this many ms remain before expiry. */
const REFRESH_SKEW_MS = 60_000;

/** Built-in subscription OAuth provider ids. */
export const OAUTH_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
] as const;

export type PraanaOAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** Mirrors pi-ai AuthPrompt (0.83+). */
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

/** Mirrors pi-ai AuthEvent (0.83+). */
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

/** Mirrors pi-ai AuthInteraction (0.83+). */
export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

interface OAuthAuth {
  name: string;
  login(interaction: AuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

interface OAuthProviderInfo {
  id: string;
  name: string;
  oauth: OAuthAuth;
}

function loadOAuthProviders(): OAuthProviderInfo[] {
  const anthropic = anthropicProvider();
  const openaiCodex = openaiCodexProvider();
  const githubCopilot = githubCopilotProvider();
  const out: OAuthProviderInfo[] = [];
  if (anthropic.auth?.oauth) {
    out.push({
      id: "anthropic",
      name: anthropic.auth.oauth.name,
      oauth: anthropic.auth.oauth as unknown as OAuthAuth,
    });
  }
  if (openaiCodex.auth?.oauth) {
    out.push({
      id: "openai-codex",
      name: openaiCodex.auth.oauth.name,
      oauth: openaiCodex.auth.oauth as unknown as OAuthAuth,
    });
  }
  if (githubCopilot.auth?.oauth) {
    out.push({
      id: "github-copilot",
      name: githubCopilot.auth.oauth.name,
      oauth: githubCopilot.auth.oauth as unknown as OAuthAuth,
    });
  }
  return out;
}

let cachedProviders: OAuthProviderInfo[] | null = null;

function oauthProviders(): OAuthProviderInfo[] {
  if (!cachedProviders) cachedProviders = loadOAuthProviders();
  return cachedProviders;
}

export function getOAuthAuth(provider: string): OAuthAuth | undefined {
  return oauthProviders().find((p) => p.id === provider)?.oauth;
}

export function isOAuthProvider(provider: string): boolean {
  return getOAuthAuth(provider) !== undefined;
}

/** True when the provider supports OAuth login (may also accept API keys). */
export function supportsOAuthLogin(provider: string): boolean {
  return isOAuthProvider(provider);
}

/** Providers that are OAuth-only in PRAANA (no paste-API-key primary path). */
export function isOAuthOnlyProvider(provider: string): boolean {
  return provider === "openai-codex" || provider === "github-copilot";
}

export function listOAuthProviders(): OAuthProviderInfo[] {
  return oauthProviders();
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

/**
 * Run the pi-ai OAuth login flow for a provider and persist the result.
 */
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

/**
 * Return a usable access token for an OAuth provider, refreshing when near expiry.
 * Persists rotated tokens. Returns null when no OAuth credentials are stored.
 */
export async function ensureFreshAccessToken(
  provider: string,
): Promise<string | null> {
  const auth = await resolveOAuthModelAuth(provider);
  return auth?.apiKey ?? null;
}

/**
 * Resolve request auth (apiKey / headers / baseUrl) from a stored OAuth bundle.
 * Refreshes when near expiry. Returns null when no OAuth credentials are stored.
 */
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

/** @internal — reset cached provider list (tests). */
export function resetOAuthProvidersForTests(): void {
  cachedProviders = null;
}
