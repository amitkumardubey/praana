/* Boot banner — figlet Standard wordmark (design §5.1), OpenTUI renderable.
 * The figlet "Standard" lines are preserved verbatim for pixel-parity with the
 * pi-tui era; they are rendered via OpenTUI TextRenderable with native
 * attributes instead of being returned as string[]. The legacy
 * renderBootBanner() string-array helper is kept only for the standalone
 * consent/pre-session UIs that may prefer it. */
import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";
import { TUI_STYLE, textAttributesOf } from "./theme.js";

/** Figlet "Standard" rendering of "praana" from the ambient design spec. */
export const PRAANA_WORDMARK: string[] = [
  "  _ __  _ __ __ _  __ _ _ __   __ _",
  " | '_ \\| '__/ _` |/ _` | '_ \\ / _` |",
  " | |_) | | | (_| | (_| | | | | (_| |",
  " | .__/|_|  \\__,_|\\__, |_| |_|\\__,_|",
  " |_|            |___/",
];

export const PRAANA_WORDMARK_WIDTH: number = PRAANA_WORDMARK.reduce(
  (max, line) => Math.max(max, line.length),
  0,
);

export interface BootBannerOpts {
  version: string;
  summaryLines: string[];
  width: number;
  noColor?: boolean;
  banner?: boolean;
}

/** Build the boot banner as a standalone OpenTUI renderable. */
export function buildBootBanner(opts: BootBannerOpts, ctx?: RenderContext): BoxRenderable {
  const showArt = (opts.banner ?? true) && opts.width >= PRAANA_WORDMARK_WIDTH;
  const wordmarkAttrs = opts.noColor ? undefined : textAttributesOf(TUI_STYLE.heading);
  const versionAttrs = opts.noColor ? undefined : textAttributesOf(TUI_STYLE.muted);

  const context = ctx ?? getSharedRenderContext();
  const container = new BoxRenderable(context, {
    id: "boot-banner",
    flexDirection: "column",
  });

  const addLine = (text: string, attributes?: number): void => {
    container.add(
      new TextRenderable(context, {
        content: text,
        ...(attributes === undefined ? {} : { attributes }),
      }),
    );
  };

  if (showArt) {
    for (const line of PRAANA_WORDMARK) {
      addLine(line, wordmarkAttrs);
    }
    addLine("");
  }

  addLine(`  v${opts.version}`, versionAttrs);
  addLine("");

  for (const summaryLine of opts.summaryLines) {
    addLine(`  ${summaryLine}`);
  }

  addLine("");
  return container;
}

// ─── Legacy compat: string[] renderer for callers that still want plain text ─
export function renderBootBanner(opts: BootBannerOpts): string[] {
  const showArt = (opts.banner ?? true) && opts.width >= PRAANA_WORDMARK_WIDTH;

  const lines: string[] = [""];

  if (showArt) {
    for (const line of PRAANA_WORDMARK) {
      lines.push(line);
    }
    lines.push("");
  }

  lines.push(`  v${opts.version}`);
  lines.push("");

  for (const summaryLine of opts.summaryLines) {
    lines.push(`  ${summaryLine}`);
  }

  lines.push("");
  return lines;
}

let sharedCtx: RenderContext | null = null;

/** Inject a renderer's RenderContext so buildBootBanner() can be called without passing it.
 *  `run.ts` calls this once with the live renderer; tests call it with the test renderer. */
export function setBannerRenderContext(ctx: RenderContext): void {
  sharedCtx = ctx;
}

function getSharedRenderContext(): RenderContext {
  if (!sharedCtx) {
    throw new Error("banner.ts: setBannerRenderContext() must be called before buildBootBanner()");
  }
  return sharedCtx as RenderContext;
}
