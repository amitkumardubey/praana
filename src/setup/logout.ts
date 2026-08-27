import { removeApiKey, listStoredProviders } from "../credentials.js";
import { listEnvDetectedProviders } from "../llm.js";
import { invalidateContextWindowsForProvider } from "../model-context.js";
import { invalidateProviderCatalog } from "../provider-catalog.js";
import {
  isUserDeclaredProvider,
  removeUserProvider,
  getProviderEnvKey,
} from "../provider-registry.js";
import { removeProviderSection, updateLlmProvider } from "./config-writer.js";
import { getEnvApiKeyForProvider, pickDefaultModel } from "./logic.js";

export interface LogoutSessionLike {
  getEffectiveProvider(): string;
  getActiveModelId?(): string;
  setProviderOverride?(provider: string | null): void;
  setModelOverride?(model: string | null): void;
  config?: {
    llm: { provider: string; model: string };
    providers?: Record<string, unknown>;
  };
}

export interface LogoutOutcome {
  provider: string;
  removed: boolean;
  sectionRemoved: boolean;
  isActiveProvider: boolean;
  lines: string[];
  /** Open the login overlay — no remaining authenticated provider. */
  needsLogin: boolean;
  switchedTo?: { provider: string; model: string };
}

function envWarningLine(provider: string): string | undefined {
  const envKey = getProviderEnvKey(provider);
  if (!envKey || !getEnvApiKeyForProvider(provider)) return undefined;
  return `Removed credentials from PRAANA store. Note: ${envKey} is still exported in your shell environment.`;
}

/**
 * Model to use after switching to `fallback`.
 *
 * Reuse config.llm.model only when config already names this fallback
 * *and* that model is not the one we are leaving (stale `model =` left
 * behind when a prior login patched provider but not model).
 */
function pickFallbackModel(
  fallback: string,
  session: LogoutSessionLike,
): string {
  const configured =
    session.config?.llm.provider === fallback
      ? session.config.llm.model.trim()
      : "";
  const active = session.getActiveModelId?.()?.trim() ?? "";
  // Config may still name the fallback provider while `model` is the one
  // we are leaving (a prior login patched provider but not model).
  if (configured && configured !== active) return configured;
  return pickDefaultModel(fallback);
}

function pickFallback(
  loggedOut: string,
  session: LogoutSessionLike,
): { provider: string; model: string } | null {
  const stored = listStoredProviders().filter((id) => id !== loggedOut);
  const envDetected = listEnvDetectedProviders().filter(
    (id) => id !== loggedOut && getProviderEnvKey(id) !== null,
  );
  const remaining = [...new Set([...stored, ...envDetected])];
  if (remaining.length === 0) return null;
  const provider = remaining[0]!;
  return { provider, model: pickFallbackModel(provider, session) };
}

function applyFallback(
  session: LogoutSessionLike,
  fallback: { provider: string; model: string },
): void {
  session.setProviderOverride?.(fallback.provider);
  if (fallback.model) session.setModelOverride?.(fallback.model);
  if (session.config) {
    session.config.llm.provider = fallback.provider;
    if (fallback.model) session.config.llm.model = fallback.model;
  }
  updateLlmProvider(fallback.provider, fallback.model || undefined);
}

function dropProviderModelCache(provider: string): void {
  invalidateProviderCatalog(provider);
  invalidateContextWindowsForProvider(provider);
}

/**
 * Remove credentials (and custom provider sections) and, when the active
 * provider is logged out, switch to a fallback or signal that login is needed.
 */
export function logoutProvider(
  provider: string,
  session: LogoutSessionLike,
): LogoutOutcome {
  const isActive = provider === session.getEffectiveProvider();
  const isCustom = isUserDeclaredProvider(provider);
  const removed = removeApiKey(provider);
  let sectionRemoved = false;
  if (isCustom) {
    sectionRemoved = removeProviderSection(provider).written;
    removeUserProvider(provider);
    if (session.config?.providers && provider in session.config.providers) {
      const next = { ...session.config.providers };
      delete next[provider];
      session.config.providers = next;
    }
  }

  if (!removed && !sectionRemoved) {
    return {
      provider,
      removed: false,
      sectionRemoved: false,
      isActiveProvider: isActive,
      lines: [`No credentials found for "${provider}".`],
      needsLogin: false,
    };
  }

  dropProviderModelCache(provider);

  const lines: string[] = [];
  const warning = envWarningLine(provider);
  let switchedTo: { provider: string; model: string } | undefined;
  let needsLogin = false;

  if (isActive) {
    const fallback = pickFallback(provider, session);
    if (fallback && fallback.provider !== provider) {
      applyFallback(session, fallback);
      switchedTo = fallback;
      lines.push(
        `Logged out of ${provider}. Switched active provider to ${fallback.provider}${fallback.model ? ` (${fallback.model})` : ""}.`,
      );
    } else {
      needsLogin = true;
      lines.push(`Logged out of ${provider}. No other provider is configured — opening login.`);
    }
  } else {
    lines.push(`Logged out: ${provider}`);
    if (session.config?.llm.provider === provider) {
      const fallback = pickFallback(provider, session);
      if (fallback) {
        applyFallback(session, fallback);
        switchedTo = fallback;
      }
    }
  }

  if (sectionRemoved) {
    lines.push(`Removed [providers.${provider}] from config.toml.`);
  }
  if (warning) lines.push(warning);

  return {
    provider,
    removed: true,
    sectionRemoved,
    isActiveProvider: isActive,
    lines,
    needsLogin,
    switchedTo,
  };
}
