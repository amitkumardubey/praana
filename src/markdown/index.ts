/**
 * @praana/markdown — standalone ANSI markdown renderer.
 *
 * Renders a Markdown string to an ANSI-escaped terminal string.
 * Handles the subset LLMs produce: bold/italic/code inline, headings, bullet
 * and ordered lists (any indentation), fenced code blocks with optional syntax
 * highlighting (cli-highlight), blockquotes, horizontal rules, and setext
 * headings.
 *
 * Designed to be extracted as its own package:
 *  - No imports from the host project.
 *  - One required peer dep: cli-highlight (optional — fallback is dim+raw).
 *  - Pure functions; no global state.
 *
 * Usage:
 *   import { renderMarkdown } from "./index.js";
 *   const ansi = renderMarkdown(md, { syntaxHighlight: true, syntaxTheme: nordTheme });
 */
export type { RendererOptions, SyntaxTheme } from "./types.js";
export { renderBlocks as renderMarkdownBlocks } from "./block.js";
export { applyInline } from "./inline.js";

import { renderBlocks } from "./block.js";
import type { RendererOptions } from "./types.js";

/**
 * Render a Markdown string to an ANSI-escaped terminal string.
 *
 * The output is always coloured/styled ANSI. When writing to a non-TTY
 * context, callers should strip it with `strip-ansi`.
 */
export function renderMarkdown(text: string, opts?: RendererOptions): string {
  if (!text) return "";
  return renderBlocks(text, opts);
}

/**
 * Create a pre-configured renderer function. Useful when the same options
 * are applied to many strings (avoids recreating the options object each call).
 */
export function createRenderer(opts?: RendererOptions): (text: string) => string {
  return (text: string) => renderMarkdown(text, opts);
}
