/**
 * Application adapter for the ANSI markdown renderer.
 *
 * Wires the standalone @praana/markdown renderer (src/markdown/) to the
 * app's syntax-theme configuration. All markdown rendering in the app goes
 * through these two exports; nothing imports from src/markdown/ directly.
 */
import { renderMarkdown as _render, createRenderer } from "./markdown/index.js";
import { resolveSyntaxTheme } from "./ui/chat-shell/syntax-themes.js";

// Pre-built renderer using the app's configured syntax theme.
// Syntax highlighting is enabled; the theme is resolved once at module load.
const _renderer = createRenderer({
  syntaxHighlight: true,
  syntaxTheme: resolveSyntaxTheme("nord"),
});

/**
 * Render Markdown text to a terminal-formatted ANSI string.
 * Returns styled ANSI — callers in the buffer/alternate path should
 * strip it with strip-ansi; the preserve/TTY path keeps it as-is.
 */
export function renderMarkdown(text: string): string {
  return _renderer(text);
}

/**
 * Render Markdown to a writable stream (stdout/stderr).
 */
export function writeMarkdown(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  if (!text) return;
  const rendered = renderMarkdown(text);
  stream.write(rendered.endsWith("\n") ? rendered : rendered + "\n");
}
