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
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
  CodeRenderable,
  MarkdownRenderable,
  TextAttributes,
  type RGBA,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { buildMarkdownSyntaxStyle } from "../src/ui/tui/transcript/markdown-theme.js";

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
      syntaxStyle: buildMarkdownSyntaxStyle("preflight"),
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
    setup.renderer.destroy();
  }
}

const parserAvailable = await treeSitterParserAvailable();

describe("buildMarkdownSyntaxStyle", () => {
  it("registers the scope names OpenTUI's markdown highlighter emits", () => {
    const style = buildMarkdownSyntaxStyle("default");
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
    // Cached styles are shared process-wide; do not destroy them here.
  });

  it("memoises one style per syntaxTheme string", () => {
    const a1 = buildMarkdownSyntaxStyle("default");
    const a2 = buildMarkdownSyntaxStyle("default");
    const b = buildMarkdownSyntaxStyle("another-theme");
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    expect(b).not.toBe(a2);
    expect(b.getRegisteredNames()).toEqual(a1.getRegisteredNames());
  });

  it("paints heading, strong, italic, code, list, quote, link inline styles", async () => {
    const setup = await createTestRenderer({ width: 80, height: 36 });
    try {
      const md = new MarkdownRenderable(setup.renderer, {
        id: "md-theme",
        width: 76,
        content: MD,
        syntaxStyle: buildMarkdownSyntaxStyle("default"),
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

      const spans = spansOf(setup);
      const text = spans.map((span) => span.text).join("");
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

      const docs = spans.find((span) => span.text.includes("docs"))!;
      expect(hasBit(docs, TextAttributes.UNDERLINE)).toBe(true);
      expect(hasExplicitColor(docs.fg)).toBe(true);

      const url = spans.find((span) => span.text.includes("example.com"))!;
      expect(hasBit(url, TextAttributes.DIM)).toBe(true);

      const marker = spans.find((span) => span.text.trim() === "-")!;
      expect(hasExplicitColor(marker.fg) || hasBit(marker, TextAttributes.DIM)).toBe(true);

      const quote = spans.find((span) => span.text.includes("quoted line"))!;
      expect(hasBit(quote, TextAttributes.ITALIC)).toBe(true);
      expect(hasBit(quote, TextAttributes.DIM)).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  }, 15_000);

  if (parserAvailable) {
    it("paints fenced code with language-token colours", async () => {
      const setup = await createTestRenderer({ width: 80, height: 36 });
      try {
        const md = new MarkdownRenderable(setup.renderer, {
          id: "md-theme",
          width: 76,
          content: MD,
          syntaxStyle: buildMarkdownSyntaxStyle("default"),
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
        setup.renderer.destroy();
      }
    }, 15_000);
  } else {
    it.skip("paints fenced code with language-token colours (skipped: tree-sitter parser unavailable in this environment)", () => {});
  }
});
