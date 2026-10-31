/* Build an OpenTUI SyntaxStyle for markdown rendering (design §4).
 * Replaces pi-tui's per-element MarkdownTheme callbacks. The scope names
 * below are best-effort; verify against OpenTUI's getRegisteredNames() at
 * implementation time and adjust if needed. */
import { SyntaxStyle, type NativeResourceOwner } from "@opentui/core";

const MARKDOWN_STYLES = {
  heading: { bold: true },
  paragraph: {},
  link: { fg: "#00AFFF" },
  "link.url": { dim: true },
  code: { bg: "#333333" },
  "code.block": {},
  quote: { italic: true, dim: true },
  "quote.border": { dim: true },
  hr: { dim: true },
  "list.bullet": { dim: true },
  strong: { bold: true },
  em: { italic: true },
  text: {},
} as const;

// OpenTUI 0.6.0 made SyntaxStyle a native resource: fromStyles() requires an
// owner (renderer.nativeScene / a ResourceContext) and the style dies with its
// owner. Creating one per <markdown> render was fine when a style was a plain
// JS object; now each call allocates a native style, so we create exactly one
// per renderer+theme and share it across every markdown component in that
// scene. The cache is keyed by the scene object identity and released from
// run.tsx when the renderer is destroyed (releaseMarkdownSyntaxStyles).
const styleCache = new Map<NativeResourceOwner, Map<string, SyntaxStyle>>();

export function buildMarkdownSyntaxStyle(
  owner: NativeResourceOwner,
  syntaxTheme?: string,
): SyntaxStyle {
  const theme = syntaxTheme ?? "default";
  let byTheme = styleCache.get(owner);
  if (!byTheme) {
    byTheme = new Map();
    styleCache.set(owner, byTheme);
  }
  const existing = byTheme.get(theme);
  if (existing) return existing;
  const style = SyntaxStyle.fromStyles(MARKDOWN_STYLES, owner);
  byTheme.set(theme, style);
  return style;
}

/** Release every style owned by `owner` (call before renderer.destroy()). */
export function releaseMarkdownSyntaxStyles(owner: NativeResourceOwner): void {
  const byTheme = styleCache.get(owner);
  if (!byTheme) return;
  for (const style of byTheme.values()) {
    style.destroy();
  }
  styleCache.delete(owner);
}
