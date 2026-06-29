/* Colour palette for the PRAANA TUI.
 *
 * Theme system (forward-compatible):
 *  - A `Theme` bundles a `dark` and a `light` `Palette` variant.
 *  - `PALETTE` is the active palette. Today it resolves to NORD.dark.
 *  - A future theming layer can re-point `PALETTE` (or select dark/light by
 *    terminal appearance) without touching any component — every component
 *    imports `PALETTE.*` rather than raw hex.
 *
 * Default theme: Nord (https://www.nordtheme.com/).
 *  - brand accent is Frost cyan (assistant headings, links, prompt, banner)
 *  - tool actions use Frost deep-blue so they never blend into the brand
 *  - reasoning (Aurora purple) is visually separate from system notices
 *  - secondary text (muted/gutter) stays legible when dimmed
 *  - `warning` is its own hue (Aurora orange), decoupled from the tool colour
 */

/** Raw Nord palette — the only place hex literals should live. */
export const NORD_COLORS = {
  // Polar Night (dark backgrounds)
  nord0: "#2E3440",
  nord1: "#3B4252",
  nord2: "#434C5E",
  nord3: "#4C566A",
  nord3b: "#616E88", // brightened nord3 (comments)
  // Snow Storm (light foregrounds)
  nord4: "#D8DEE9",
  nord5: "#E5E9F0",
  nord6: "#ECEFF4",
  // Frost (cool accents)
  nord7: "#8FBCBB",
  nord8: "#88C0D0",
  nord9: "#81A1C1",
  nord10: "#5E81AC",
  // Aurora (semantic / status)
  nord11: "#BF616A", // red
  nord12: "#D08770", // orange
  nord13: "#EBCB8B", // yellow
  nord14: "#A3BE8C", // green
  nord15: "#B48EAD", // purple
} as const;

export type Palette = {
  user: string;
  assistant: string;
  thinking: string;
  tool: string;
  system: string;
  border: string;
  gutter: string;
  muted: string;
  faint: string;
  warning: string;
  error: string;
  info: string;
  success: string;
  text: string;
  /** Surfaces — backgrounds for code blocks and inline code spans */
  codeBg: string;
  codeSpanBg: string;
};

export type Theme = {
  name: string;
  /** cli-highlight syntax theme name to use for fenced code blocks */
  syntaxTheme: string;
  dark: Palette;
  light: Palette;
};

const c = NORD_COLORS;

/** Nord — dark variant (default). Tuned for a Polar Night terminal bg. */
const NORD_DARK: Palette = {
  user: c.nord14,        // Aurora green — user input
  assistant: c.nord8,    // Frost cyan — brand accent: headings, links, prompt
  thinking: c.nord15,    // Aurora purple — reasoning, distinct from system
  tool: c.nord10,        // Frost deep-blue — tool actions, distinct from brand
  system: c.nord4,       // Snow Storm — system notices, legible when dimmed
  border: c.nord8,       // brand cyan for input bar
  gutter: c.nord3,       // Polar Night 3 — visible turn/table separators
  muted: c.nord4,        // Snow Storm — secondary text, legible when dimmed
  faint: c.nord3b,       // brightened nord3 — extra-dim accents (bullets, hr)
  warning: c.nord12,     // Aurora orange — threshold warnings
  error: c.nord11,       // Aurora red
  info: c.nord9,         // Frost blue
  success: c.nord14,     // Aurora green
  text: c.nord6,         // Snow Storm 3 — primary text
  codeBg: c.nord0,       // Polar Night 0 — fenced code block background
  codeSpanBg: c.nord1,   // Polar Night 1 — inline `code` span background
};

/** Nord — light variant. Tuned for a Snow Storm terminal bg.
 *  Cool accents are darkened (Frost deep tones) for contrast on light. */
const NORD_LIGHT: Palette = {
  user: c.nord14,
  assistant: c.nord10,   // Frost deep-blue brand — strong on light bg
  thinking: c.nord15,
  tool: c.nord9,         // Frost blue
  system: c.nord3,       // Polar Night — readable on light
  border: c.nord10,
  gutter: c.nord4,       // Snow Storm separators on light bg
  muted: c.nord3,
  faint: c.nord2,
  warning: c.nord12,
  error: c.nord11,
  info: c.nord10,
  success: c.nord14,
  text: c.nord0,         // Polar Night 0 — primary text
  codeBg: c.nord5,       // Snow Storm 5 — code block background
  codeSpanBg: c.nord4,   // Snow Storm 4 — inline code span background
};

export const NORD: Theme = {
  name: "nord",
  syntaxTheme: "nord",
  dark: NORD_DARK,
  light: NORD_LIGHT,
};

/** The active theme. Re-point this in a future theming layer. */
export const ACTIVE_THEME: Theme = NORD;

/** The active palette. Components import this; do not inline hex. */
export const PALETTE: Palette = ACTIVE_THEME.dark;
