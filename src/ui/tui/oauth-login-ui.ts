/**
 * Shared OAuth login UI helpers for TUI wizards.
 * Bridges pi-ai AuthInteraction to status lines + text/select prompts.
 */
import { openBrowserUrl } from "../../oauth-browser.js";
import {
  runOAuthLogin,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
} from "../../oauth.js";
import type { StoredOAuthCredential } from "../../credentials.js";

export interface OAuthUiSink {
  /** Replace the wizard body with status lines and request a render. */
  showStatus(lines: string[]): void;
  /**
   * Prompt for a single line of text (paste code, etc.).
   * `contextLines` stay visible above the input (e.g. the auth URL).
   */
  promptText(
    message: string,
    placeholder?: string,
    contextLines?: string[],
  ): Promise<string>;
  /** Interactive select; return option id or undefined on cancel. */
  promptSelect(
    message: string,
    options: readonly { id: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  /** Abort signal cancelled when the user presses Esc. */
  signal: AbortSignal;
}

/** Soft-wrap a long URL so it stays readable in narrow terminals. */
export function wrapUrlForDisplay(url: string, width = 72): string[] {
  if (url.length <= width) return [url];
  const lines: string[] = [];
  for (let i = 0; i < url.length; i += width) {
    lines.push(url.slice(i, i + width));
  }
  return lines;
}

function authUrlContext(
  provider: string,
  url: string,
  instructions?: string,
): string[] {
  return [
    `Sign in to ${provider}`,
    "",
    instructions ?? "Complete login in the browser to finish.",
    "",
    "Open this URL:",
    ...wrapUrlForDisplay(url),
    "",
    "If the browser did not open, copy the URL above into your browser.",
  ];
}

function deviceCodeContext(
  provider: string,
  verificationUri: string,
  userCode: string,
): string[] {
  return [
    `Sign in to ${provider}`,
    "",
    `Go to: ${verificationUri}`,
    `Enter code: ${userCode}`,
    "",
    "Waiting for authorization…",
  ];
}

/**
 * Run OAuth login with UI callbacks. Opens the browser on auth URL when possible.
 * Keeps the auth URL visible while prompting for a pasted code/redirect.
 */
export async function runOAuthLoginWithUi(
  provider: string,
  ui: OAuthUiSink,
): Promise<StoredOAuthCredential> {
  let lastContext: string[] = [];

  const interaction: AuthInteraction = {
    signal: ui.signal,
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case "auth_url":
          lastContext = authUrlContext(provider, event.url, event.instructions);
          ui.showStatus(lastContext);
          openBrowserUrl(event.url);
          break;
        case "device_code":
          lastContext = deviceCodeContext(
            provider,
            event.verificationUri,
            event.userCode,
          );
          ui.showStatus(lastContext);
          openBrowserUrl(event.verificationUri);
          break;
        case "progress":
        case "info":
          ui.showStatus(
            lastContext.length > 0
              ? [...lastContext, "", event.message]
              : [event.message],
          );
          break;
      }
    },
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === "select") {
        const selected = await ui.promptSelect(prompt.message, prompt.options);
        if (selected === undefined) {
          throw new Error("cancelled");
        }
        return selected;
      }
      // manual_code / text / secret — keep auth URL visible above the input.
      const context =
        prompt.type === "manual_code" && lastContext.length > 0
          ? lastContext
          : undefined;
      return ui.promptText(prompt.message, prompt.placeholder, context);
    },
  };

  return runOAuthLogin(provider, interaction);
}
