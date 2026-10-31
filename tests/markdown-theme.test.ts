/**
 * Markdown theme scopes against OpenTUI's real renderer.
 *
 * OpenTUI looks up `markup.*` scopes (and numbered heading levels such as
 * `markup.heading.1`). The theme used to register invented names (`heading`,
 * `strong`, `em`, …) that the renderer never reads. Attribute bits are
 * OpenTUI's TextAttributes (bold=1, dim=2, italic=4, underline=8).
 */
import { describe, expect, it } from "bun:test";
import { MarkdownRenderable, TextAttributes, type RGBA } from "@opentui/core";
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
    style.destroy();
  });

  it("paints heading, strong, italic, code, list, quote, link and fenced code", async () => {
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

      const spansOf = (): Span[] => setup.captureSpans().lines.flatMap((line) => line.spans);

      let headingReady = false;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await setup.renderOnce();
        const heading = spansOf().find((span) => span.text.includes("Heading one"));
        if (heading && hasBit(heading, TextAttributes.BOLD) && hasExplicitColor(heading.fg)) {
          headingReady = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      const spans = spansOf();
      const text = spans.map((span) => span.text).join("");
      expect(text).toContain("Heading one");
      expect(text).toContain("strong text");
      expect(text).toContain("em text");
      expect(text).toContain("code span");
      expect(text).toContain("quoted line");
      expect(text).toContain("const x: number = 1;");
      expect(headingReady, "heading should be bold and coloured once styles land").toBe(true);

      const heading = spans.find((span) => span.text.includes("Heading one"))!;
      expect(hasBit(heading, TextAttributes.BOLD)).toBe(true);
      expect(hasExplicitColor(heading.fg)).toBe(true);

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

      const keyword = spans.find((span) => span.text.includes("const"))!;
      const literal = spans.find((span) => span.text.includes("1"))!;
      expect(hasExplicitColor(keyword.fg)).toBe(true);
      expect(hasExplicitColor(literal.fg)).toBe(true);
      // Language tokens must not collapse to one flat colour.
      expect(keyword.fg.equals(literal.fg)).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  }, 20_000);
});
