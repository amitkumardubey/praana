/**
 * Markdown rendering for the terminal.
 * Uses marked + marked-terminal to convert Markdown to styled terminal output.
 *
 * Only active when stdout/stderr is a TTY (chalk auto-detects).
 */

import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  marked.use(
    new markedTerminal({
      // Disable reflow — we want to preserve the original line breaks
      reflowText: false,
      // Don't add section prefixes like "h1. "
      showSectionPrefix: false,
      // Unescape HTML entities
      unescape: true,
      // Use a dark theme for code blocks
      code: { theme: "solarized-dark" },
    })
  );
  initialized = true;
}

/**
 * Render Markdown text to a terminal-formatted string with ANSI styles.
 * Returns plain text when not in a TTY (chalk strips colors automatically).
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  ensureInit();
  // marked.parse returns string when used with synchronous renderer
  return marked.parse(text) as string;
}

/**
 * Render Markdown to a writable stream (stdout/stderr).
 */
export function writeMarkdown(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  if (!text) return;
  const rendered = renderMarkdown(text);
  stream.write(rendered);
  if (!rendered.endsWith("\n")) stream.write("\n");
}
