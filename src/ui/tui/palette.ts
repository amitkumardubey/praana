/* Colour palette for the PRAANA TUI.
 *
 * Design goals:
 *  - amber is the brand accent (assistant headings, links, prompt, banner)
 *  - tool actions use a distinct cyan so they never blend into amber accents
 *  - reasoning (violet) is visually separate from system notices (slate)
 *  - secondary text (muted/gutter) is bright enough to stay legible after
 *    Ink applies dimColor on dark terminals
 *  - `warning` is its own hue, decoupled from the tool colour
 */
export const PALETTE = {
  user: "#86efac",       // green-300 — user input, readable on dark bg
  assistant: "#fbbf24",  // amber-400 — brand accent: headings, links, prompt
  thinking: "#a78bfa",   // violet-400 — reasoning, distinct from system
  tool: "#38bdf8",       // sky-400 — tool actions/icons, distinct from amber
  system: "#94a3b8",     // slate-400 — system notices, legible when dimmed
  border: "#fbbf24",     // amber-400 for input bar
  gutter: "#52606d",     // slate-600+ — visible turn/table separators
  muted: "#94a3b8",      // slate-400 — secondary text, legible when dimmed
  faint: "#64748b",      // slate-500 — extra-dim accents (bullets, hr)
  warning: "#f59e0b",    // amber-500 — threshold warnings (ctx 70-90%)
  error: "#f87171",      // red-400 — softer red, readable
  info: "#60a5fa",       // blue-400
  success: "#4ade80",    // green-400
  text: "#FAF9F6",
  /* Surfaces — backgrounds for code blocks and inline code spans */
  codeBg: "#1e1e1e",     // fenced code block background
  codeSpanBg: "#2d2d2d"  // inline `code` span background
};
