/**
 * Shared OAuth login UI helpers for TUI wizards.
 * Bridges AuthInteraction to status lines + text/select prompts.
 */
import { openBrowserUrl } from "../../oauth-browser.js";
import { CodexManualPromptSuperseded } from "../../oauth-codex.js";
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

/**
 * Thrown when the user cancels an interactive OAuth prompt (Esc). The
 * wizard treats this as a quiet cancel back to the previous step — never
 * as a failed login.
 */
export class OAuthUserCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "OAuthUserCancelledError";
  }
}

/**
 * Map a select-prompt outcome to the chosen option id, treating a
 * cancelled (undefined) selection as a user cancel.
 */
export function resolveOAuthSelectSelection(selected: string | undefined): string {
  if (selected === undefined) throw new OAuthUserCancelledError();
  return selected;
}

/**
 * Error for a text prompt whose AbortSignal fired.
 * User Esc aborts with {@link OAuthUserCancelledError}; that reason is
 * returned unchanged so the wizard can step back. Every other abort is an
 * AbortError carrying `signal.reason`.
 */
export function oauthPromptAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof OAuthUserCancelledError) return reason;
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
 * Single-line OAuth prompt. The abort listener is the only dismissal path:
 * user Esc rejects with {@link OAuthUserCancelledError}, and every other
 * signal abort rejects with {@link oauthPromptAbortError}. A Codex
 * manual-prompt abort (callback already won) still rejects here; the login
 * caller swallows only that abort so the overall login can finish.
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

/**
 * Leave the URL as one string. The login `<text>` uses `wrapMode="char"`,
 * which soft-wraps on screen without writing newlines into the buffer, so a
 * copy is still the original URL. Hard wraps become real line breaks and
 * break paste. `width` is unused; callers used to pass a column budget.
 */
export function wrapUrlForDisplay(url: string, _width = 72): string[] {
  return [url];
}

/** Login OAuth frame width. 76 columns leaves 72 for text after border and padding. */
export const LOGIN_OAUTH_FRAME_WIDTH = 76;
/** Title, paste field, and hint stay outside the scrolling URL block. */
const LOGIN_OAUTH_CHROME_ROWS = 3;

/** Join the auth-url lines and the paste prompt. Empty separators are dropped so the URL is not split by blank lines. */
export function formatOAuthManualPrompt(contextLines: readonly string[], prompt: string): string {
  return [...contextLines, prompt].filter((line) => line.length > 0).join("\n");
}

/** Rows a char-wrapped block occupies. A URL has no spaces, so word wrap would not break it. */
export function charWrappedRows(text: string, columns: number): number {
  if (columns < 1) return 0;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / columns));
  }
  return rows;
}

/** Geometry shared by the login overlay and the headless fit check. Matches OverlayFrame. */
export function loginOauthFrame(rows: number, cols: number): {
  width: number;
  top: number;
  maxHeight: number;
  contentColumns: number;
  bodyRows: number;
} {
  const height = rows || 24;
  const widthCols = cols || 80;
  const width = Math.min(LOGIN_OAUTH_FRAME_WIDTH, Math.max(20, widthCols - 4));
  const top = Math.max(1, Math.floor(height / 5));
  const maxHeight = Math.max(8, height - top);
  const contentColumns = Math.max(1, width - 4);
  const contentRows = Math.max(1, maxHeight - 4);
  return {
    width,
    top,
    maxHeight,
    contentColumns,
    bodyRows: Math.max(1, contentRows - LOGIN_OAUTH_CHROME_ROWS),
  };
}

/** True when the paste body fits the login overlay without scrolling, input included. */
export function oauthManualPromptFits(rows: number, cols: number, body: string): boolean {
  const frame = loginOauthFrame(rows, cols);
  return charWrappedRows(body, frame.contentColumns) <= frame.bodyRows;
}

function authUrlContext(
  provider: string,
  url: string,
  instructions?: string,
): string[] {
  return [
    `Sign in to ${provider}`,
    instructions ?? "Complete login in the browser to finish.",
    "Open this URL:",
    ...wrapUrlForDisplay(url),
    "If the browser did not open, copy the URL above into your browser.",
  ];
}

function openBrowserBestEffort(
  openBrowser: (url: string) => void | Promise<boolean>,
  url: string,
): void {
  void Promise.resolve()
    .then(async () => {
      await openBrowser(url);
    })
    .catch(() => {});
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
          openBrowserBestEffort(openBrowser, event.url);
          break;
        case "device_code":
          lastContext = deviceCodeContext(
            provider,
            event.verificationUri,
            event.userCode,
          );
          ui.showStatus(lastContext);
          openBrowserBestEffort(openBrowser, event.verificationUri);
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
        return resolveOAuthSelectSelection(selected);
      }
      // manual_code / text / secret — keep auth URL visible above the input.
      const context =
        prompt.type === "manual_code" && lastContext.length > 0
          ? lastContext
          : undefined;
      try {
        return await ui.promptText(prompt.message, prompt.placeholder, context, prompt.signal);
      } catch (error) {
        // Only this paste prompt was aborted. Reject so login can settle; do not wait forever.
        if (prompt.signal?.aborted && !ui.signal.aborted) {
          throw new CodexManualPromptSuperseded();
        }
        throw error;
      }
    },
  };

  return runOAuthLogin(provider, interaction);
}
