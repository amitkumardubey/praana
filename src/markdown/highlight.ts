/**
 * Syntax highlighting wrapper around cli-highlight.
 * Fails silently — if cli-highlight is unavailable or the language is unknown,
 * the raw code is returned unchanged.
 */
import type { SyntaxTheme } from "./types.js";

let _highlight: ((code: string, opts: { language?: string; theme?: SyntaxTheme | string; ignoreIllegals?: boolean }) => string) | null = null;

async function loadHighlight(): Promise<typeof _highlight> {
  if (_highlight !== null) return _highlight;
  try {
    const mod = await import("cli-highlight");
    _highlight = mod.highlight;
  } catch {
    _highlight = null;
  }
  return _highlight;
}

// Pre-load eagerly so the first render isn't async.
void loadHighlight();

export function highlightSync(
  code: string,
  language: string,
  theme: SyntaxTheme | string | undefined,
): string {
  if (!_highlight) return code;
  try {
    return _highlight(code, { language: language || "plaintext", theme, ignoreIllegals: true });
  } catch {
    return code;
  }
}
