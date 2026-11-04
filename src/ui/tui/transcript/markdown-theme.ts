/* OpenTUI SyntaxStyle for markdown.
 *
 * The highlighter emits full scope names (`markup.heading.1`, `markup.strong`,
 * …). SyntaxStyle only falls back to the segment before the first dot, so
 * `markup.heading` does not style `markup.heading.1` — each level is registered
 * with the same style. `markup.raw.block` is background-only so a fenced
 * block's language tokens keep their own colours. SyntaxStyle has no
 * strikethrough bit; `markup.strikethrough` is dim and coloured instead.
 * `syntaxTheme` is accepted and unused (theme selection is separate).
 *
 * Styles are native resources, cached per owner and theme. */
import { SyntaxStyle, type NativeResourceOwner, type StyleDefinitionInput } from "@opentui/core";

const HEADING: StyleDefinitionInput = { bold: true, fg: "#7aa2f7" };
const LIST: StyleDefinitionInput = { fg: "#c4887a", dim: true };

function buildStyles(): Record<string, StyleDefinitionInput> {
  const styles: Record<string, StyleDefinitionInput> = {
    "markup.heading": HEADING,
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: "#9ece6a", bg: "#262830" },
    "markup.raw.block": { bg: "#1e2030" },
    "markup.link": { fg: "#7dcfff", underline: true },
    "markup.link.label": { fg: "#7dcfff", underline: true },
    "markup.link.url": { fg: "#7a8294", dim: true },
    "markup.list": LIST,
    "markup.list.unchecked": LIST,
    "markup.list.checked": LIST,
    "markup.quote": { fg: "#a0a8b8", italic: true, dim: true },
    "markup.strikethrough": { fg: "#e06c75", dim: true },
    conceal: { fg: "#565f89", dim: true },
    // Base language scopes. Nested names (`keyword.import`, `function.call`)
    // fall back to the first segment, so fenced code stays multi-coloured.
    keyword: { fg: "#bb9af7" },
    string: { fg: "#9ece6a" },
    comment: { fg: "#565f89", italic: true, dim: true },
    type: { fg: "#2ac3de" },
    function: { fg: "#7aa2f7" },
    number: { fg: "#ff9e64" },
    constant: { fg: "#ff9e64" },
    variable: { fg: "#c0caf5" },
    operator: { fg: "#89ddff" },
    punctuation: { fg: "#737aa2" },
  };
  for (let level = 1; level <= 6; level++) {
    styles[`markup.heading.${level}`] = HEADING;
  }
  return styles;
}

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
  const style = SyntaxStyle.fromStyles(buildStyles(), owner);
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
