/**
 * Shared OAuth login UI helpers for TUI wizards.
 * Bridges AuthInteraction to status lines + text/select prompts.
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
    signal?: AbortSignal,
  ): Promise<string>;
  /** Interactive select; return option id or undefined on cancel. */
  promptSelect(
    message: string,
    options: readonly { id: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  /** Abort signal cancelled when the user presses Esc. */
  signal: AbortSignal;
}

/** AbortError carrying `signal.reason`, matching a cancelled text prompt. */
export function oauthPromptAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return reason;
    const error = new Error(reason.message, { cause: reason });
    error.name = "AbortError";
    return error;
  }
  const message = typeof reason === "string" && reason.trim()
    ? reason
    : "The operation was aborted.";
  return new DOMException(message, "AbortError");
}

/**
 * Single-line OAuth prompt. Abort rejects with {@link oauthPromptAbortError}.
 * A Codex manual-prompt abort (callback already won) still rejects here; the
 * login caller swallows only that abort so the overall login can finish.
 */
export function createOAuthTextPrompt(options: {
  signal: AbortSignal;
  promptSignal?: AbortSignal;
  onDismiss?: () => void;
  present: (submit: (value: string) => void) => void;
}): Promise<string> {
  const signal = options.promptSignal
    ? AbortSignal.any([options.signal, options.promptSignal])
    : options.signal;
  return new Promise<string>((resolve, reject) => {
    const fail = () => {
      options.onDismiss?.();
      reject(oauthPromptAbortError(signal));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    const detach = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      detach();
      fail();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    options.present((value) => {
      if (!value.trim()) return;
      detach();
      options.onDismiss?.();
      resolve(value.trim());
    });
  });
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
  openBrowser: (url: string) => void | Promise<boolean> = openBrowserUrl,
): Promise<StoredOAuthCredential> {
  let lastContext: string[] = [];

  const interaction: AuthInteraction = {
    signal: ui.signal,
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case "auth_url":
          lastContext = authUrlContext(provider, event.url, event.instructions);
          ui.showStatus(lastContext);
          void openBrowser(event.url);
          break;
        case "device_code":
          lastContext = deviceCodeContext(
            provider,
            event.verificationUri,
            event.userCode,
          );
          ui.showStatus(lastContext);
          void openBrowser(event.verificationUri);
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
      try {
        return await ui.promptText(prompt.message, prompt.placeholder, context, prompt.signal);
      } catch (error) {
        // Callback won: only the per-prompt manual signal aborted. Detach quietly.
        if (prompt.signal?.aborted && !ui.signal.aborted) {
          return await new Promise<string>(() => {});
        }
        throw error;
      }
    },
  };

  return runOAuthLogin(provider, interaction);
}
