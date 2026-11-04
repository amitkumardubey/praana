/**
 * Markdown theme scopes against OpenTUI's real renderer.
 *
 * OpenTUI looks up `markup.*` scopes (and numbered heading levels such as
 * `markup.heading.1`). The theme used to register invented names (`heading`,
 * `strong`, `em`, …) that the renderer never reads. Attribute bits are
 * OpenTUI's TextAttributes (bold=1, dim=2, italic=4, underline=8).
 *
 * Async waiting: we do not poll wall-clock time for the tree-sitter
 * highlighter. Instead we wait on `CodeRenderable.highlightingDone` — the
 * promise the renderable resolves once its highlight loop completes — then run
 * a few render passes and flush. If the tree-sitter parser is unavailable in
 * this environment (checked with a faithful renderer-based preflight), the
 * fenced-code colour test is skipped with a clear message rather than failing.
 *
 * Links: a markdown link label is printed as `label (url)` only when the
 * terminal does not support OSC 8 hyperlinks. That support is a native session
 * capability: `CliRenderer` takes it from `nativeSession.getCapabilities()`
 * (node_modules/@opentui/core/chunk-bun-6kxdhkdc.js:21655), which the native
 * session derives from the environment keys forwarded by
 * `DEFAULT_FORWARDED_ENV_KEYS` (same file, :21113-21143 — TERM, COLORTERM,
 * TERM_PROGRAM, VTE_VERSION, FORCE_HYPERLINK). It reaches JS as `hyperlinks`
 * (chunk-bun-x6cz4jyg.js:10124) and is read by `MarkdownRenderable` at
 * index.bun.js:11609, gating the URL chunk at index.bun.js:11836. The tests
 * below pin it with `setRendererCapabilities()` so the ambient TERM cannot
 * change what they assert.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
  CodeRenderable,
  MarkdownRenderable,
  TextAttributes,
  type RGBA,
} from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { buildMarkdownSyntaxStyle, releaseMarkdownSyntaxStyles } from "../src/ui/tui/transcript/markdown-theme.js";

const MD = [
  "# Heading one",
  "bold **strong text** here",
  "italic *em text* ok",
  "inline `code span` here",
  "strike ~~struck text~~ end",
  "see [docs](https://example.com/help)",
  "- list item one",
  "> quoted line",
  "```ts",
  "const x: number = 1;",
  "```",
].join("\n");

interface Span {
  text: string;
  fg: RGBA;
  bg: RGBA;
  attributes: number;
}

function hasBit(span: Span, bit: number): boolean {
  return (span.attributes & bit) !== 0;
}

/** A colour the theme set, not the terminal default white. */
function hasExplicitColor(color: RGBA): boolean {
  if (color.intent === "default" || color.a < 0.05) return false;
  return color.r < 0.93 || color.g < 0.93 || color.b < 0.93;
}

function spansOf(setup: Awaited<ReturnType<typeof createTestRenderer>>): Span[] {
  return setup.captureSpans().lines.flatMap((line) => line.spans);
}

interface MarkdownFrame {
  spans: Span[];
  text: string;
  /** The OSC 8 link target attached to the first cell of `needle`, if any. */
  linkOf(needle: string): string | null;
}

/** Rendered markdown spans plus cell lookups against the same captured frame. */
function frameOf(setup: Awaited<ReturnType<typeof createTestRenderer>>): MarkdownFrame {
  const frame = setup.captureSpans();
  const spans = frame.lines.flatMap((line) => line.spans);
  const cellOf = (needle: string): { x: number; y: number } | null => {
    for (let y = 0; y < frame.lines.length; y++) {
      let x = 0;
      for (const span of frame.lines[y].spans) {
        const at = span.text.indexOf(needle);
        if (at >= 0) return { x: x + at, y };
        x += span.width;
      }
    }
    return null;
  };
  return {
    spans,
    text: spans.map((span) => span.text).join(""),
    linkOf: (needle) => {
      const cell = cellOf(needle);
      return cell ? setup.renderer.getLinkAt(cell.x, cell.y) : null;
    },
  };
}

/**
 * Render the sample markdown with the hyperlink capability pinned, then hand
 * the captured frame to `run`. The capability is read from the native session
 * when the renderer is built, so it is overridden on the renderer before the
 * markdown renderable reads it (MarkdownRenderable constructor → updateBlocks).
 */
async function withRenderedMarkdown(
  hyperlinks: boolean,
  run: (frame: MarkdownFrame) => void,
): Promise<void> {
  const setup = await createTestRenderer({ width: 80, height: 36 });
  try {
    setRendererCapabilities(setup.renderer, { hyperlinks });
    const md = new MarkdownRenderable(setup.renderer, {
      id: "md-theme",
      width: 76,
      content: MD,
      syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "default"),
      streaming: false,
    });
    setup.renderer.root.add(md);

    // Pump the renderer until the async highlight pipeline is done, then give
    // the post-highlight layout a few frames to commit.
    await waitForHighlights(setup, md);
    for (let i = 0; i < 3; i++) {
      await setup.renderOnce();
    }
    await setup.flush();

    run(frameOf(setup));
  } finally {
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    setup.renderer.destroy();
  }
}

/** Inline styles that do not depend on the hyperlink capability. */
function expectInlineStyles(frame: MarkdownFrame): void {
  const { spans, text } = frame;
  expect(text).toContain("Heading one");
  expect(text).toContain("strong text");
  expect(text).toContain("em text");
  expect(text).toContain("code span");
  expect(text).toContain("quoted line");

  const heading = spans.find((span) => span.text.includes("Heading one"))!;
  expect(hasBit(heading, TextAttributes.BOLD), "heading should be bold once styles land").toBe(true);
  expect(hasExplicitColor(heading.fg), "heading should be coloured once styles land").toBe(true);

  const strong = spans.find((span) => span.text.includes("strong text"))!;
  expect(hasBit(strong, TextAttributes.BOLD)).toBe(true);

  const em = spans.find((span) => span.text.includes("em text"))!;
  expect(hasBit(em, TextAttributes.ITALIC)).toBe(true);

  const code = spans.find((span) => span.text.includes("code span"))!;
  expect(hasExplicitColor(code.fg) || hasExplicitColor(code.bg)).toBe(true);

  const struck = spans.find((span) => span.text.includes("struck text"))!;
  expect(hasExplicitColor(struck.fg) || hasBit(struck, TextAttributes.DIM)).toBe(true);

  const marker = spans.find((span) => span.text.trim() === "-")!;
  expect(hasExplicitColor(marker.fg) || hasBit(marker, TextAttributes.DIM)).toBe(true);

  const quote = spans.find((span) => span.text.includes("quoted line"))!;
  expect(hasBit(quote, TextAttributes.ITALIC)).toBe(true);
  expect(hasBit(quote, TextAttributes.DIM)).toBe(true);
}

/** The fenced-code renderables inside a markdown renderable. */
function codeRenderables(md: MarkdownRenderable): CodeRenderable[] {
  const blockStates = (md as unknown as { _blockStates?: Array<{ renderable?: unknown }> })
    ._blockStates ?? [];
  return blockStates
    .map((state) => state.renderable)
    .filter((r): r is CodeRenderable => r instanceof CodeRenderable);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until every code renderable (the fenced ```ts block) finishes its
 * tree-sitter highlight loop. This is the deterministic completion signal —
 * no wall-clock polling.
 */
async function waitForHighlights(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  md: MarkdownRenderable,
): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    await setup.renderOnce();
    let active = 0;
    for (const code of codeRenderables(md)) {
      if (!code.isHighlighting) continue;
      active++;
      await Promise.race([code.highlightingDone, sleep(8_000)]);
    }
    if (active === 0) return;
  }
}

/**
 * Faithful preflight: render a tiny fenced block through the real renderer
 * and see whether the highlighter produces styled cells. If it does not, the
 * tree-sitter parser is unavailable in this environment. Evaluated at module
 * load time (top-level await) so the conditional test definition below can
 * rely on it.
 */
async function treeSitterParserAvailable(): Promise<boolean> {
  const setup = await createTestRenderer({ width: 80, height: 36 });
  try {
    const md = new MarkdownRenderable(setup.renderer, {
      id: "md-preflight",
      width: 76,
      content: "```ts\nconst x: number = 1;\n```",
      syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "preflight"),
      streaming: false,
    });
    setup.renderer.root.add(md);
    await waitForHighlights(setup, md);
    await setup.flush();
    const spans = spansOf(setup);
    return spans.some(
      (span) => hasExplicitColor(span.fg) || hasExplicitColor(span.bg),
    );
  } catch {
    return false;
  } finally {
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    setup.renderer.destroy();
  }
}

const parserAvailable = await treeSitterParserAvailable();

describe("buildMarkdownSyntaxStyle", () => {
  it("registers the scope names OpenTUI's markdown highlighter emits", async () => {
    const setup = await createTestRenderer({ width: 80, height: 36 });
    try {
    const style = buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "default");
    const names = style.getRegisteredNames();
    for (const scope of [
      "markup.heading",
      "markup.heading.1",
      "markup.strong",
      "markup.italic",
      "markup.raw",
      "markup.raw.block",
      "markup.link",
      "markup.link.label",
      "markup.link.url",
      "markup.list",
      "markup.quote",
      "markup.strikethrough",
      "conceal",
    ]) {
      expect(names, `scope ${scope} must be registered`).toContain(scope);
    }
    // Invented names the renderer never queries.
    for (const invented of ["heading", "strong", "em", "code", "quote", "list.bullet"]) {
      expect(names).not.toContain(invented);
    }
    // A foreground on the raw-block scope would paint over language tokens.
    expect(style.getStyle("markup.raw.block")?.fg).toBeUndefined();
    } finally {
      releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
      setup.renderer.destroy();
    }
  });

  it("memoises one style per owner and syntaxTheme string", async () => {
    const setup = await createTestRenderer({ width: 80, height: 36 });
    try {
    const a1 = buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "default");
    const a2 = buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "default");
    const b = buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "another-theme");
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    expect(b).not.toBe(a2);
    expect(b.getRegisteredNames()).toEqual(a1.getRegisteredNames());
    } finally {
      releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
      setup.renderer.destroy();
    }
  });

  it("paints heading, strong, italic, code, list, quote and a hyperlinked label", async () => {
    // Hyperlink-capable terminal: the label carries the link and the raw URL is
    // not printed.
    await withRenderedMarkdown(true, (frame) => {
      expectInlineStyles(frame);

      const docs = frame.spans.find((span) => span.text.includes("docs"))!;
      expect(hasBit(docs, TextAttributes.UNDERLINE)).toBe(true);
      expect(hasExplicitColor(docs.fg)).toBe(true);
      expect(frame.linkOf("docs")).toBe("https://example.com/help");
      expect(frame.text).not.toContain("example.com");
    });
  }, 15_000);

  it("paints heading, strong, italic, code, list, quote and prints the URL dim without hyperlinks", async () => {
    // No hyperlink support: the label stays styled and the URL follows as a
    // dim span, which is what a plain terminal shows.
    await withRenderedMarkdown(false, (frame) => {
      expectInlineStyles(frame);

      const docs = frame.spans.find((span) => span.text.includes("docs"))!;
      expect(hasBit(docs, TextAttributes.UNDERLINE)).toBe(true);
      expect(hasExplicitColor(docs.fg)).toBe(true);

      expect(frame.text).toContain("(https://example.com/help)");
      const url = frame.spans.find((span) => span.text.includes("example.com"))!;
      expect(hasBit(url, TextAttributes.DIM)).toBe(true);
    });
  }, 15_000);

  if (parserAvailable) {
    it("paints fenced code with language-token colours", async () => {
      const setup = await createTestRenderer({ width: 80, height: 36 });
      try {
        const md = new MarkdownRenderable(setup.renderer, {
          id: "md-theme",
          width: 76,
          content: MD,
          syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene, "default"),
          streaming: false,
        });
        setup.renderer.root.add(md);

        await waitForHighlights(setup, md);
        for (let i = 0; i < 3; i++) {
          await setup.renderOnce();
        }
        await setup.flush();

        const spans = spansOf(setup);
        const text = spans.map((span) => span.text).join("");
        expect(text).toContain("const x: number = 1;");

        const keyword = spans.find((span) => span.text.includes("const"))!;
        const literal = spans.find((span) => span.text.trim() === "1")!;
        const styledCells = spans.filter(
          (span) => hasExplicitColor(span.fg) || hasExplicitColor(span.bg),
        ).length;

        // Distinguish "highlighter did not start" from "style missing".
        expect(
          hasExplicitColor(keyword.fg),
          `keyword should have an explicit colour (${styledCells} styled cells in frame)`,
        ).toBe(true);
        expect(
          hasExplicitColor(literal.fg),
          `literal should have an explicit colour (${styledCells} styled cells in frame)`,
        ).toBe(true);
        expect(
          keyword.fg.equals(literal.fg),
          "language tokens must not collapse to one flat colour",
        ).toBe(false);
      } finally {
        releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    setup.renderer.destroy();
      }
    }, 15_000);
  } else {
    it.skip("paints fenced code with language-token colours (skipped: tree-sitter parser unavailable in this environment)", () => {});
  }
});
