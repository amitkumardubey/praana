import { expect, it } from "bun:test";
import { CodeRenderable, MarkdownRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { rawSyntaxLines } from "../scripts/tui-bounce/metrics.js";
import { buildMarkdownSyntaxStyle, releaseMarkdownSyntaxStyles } from "../src/ui/tui/transcript/markdown-theme.js";

/** Upstream control: intentionally uses OpenTUI, not PRAANA's wrapper. */
it("traces OpenTUI's coalesced inline preview painting block source before highlighting", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12, footerHeight: 0 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const frames: string[][] = [];
  const capture = () => { frames.push(rawSyntaxLines(setup.captureSpans().lines)); };
  try {
    const markdown = new MarkdownRenderable(setup.renderer, {
      syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene),
      streaming: true,
      content: "## Build systems\n\n- **Goals** define results.",
    });
    setup.renderer.root.add(markdown);
    const code = markdown.getChildren()[0];
    expect(code).toBeInstanceOf(CodeRenderable);
    if (!(code instanceof CodeRenderable)) throw new Error("expected coalesced code block");
    // Control only the highlight completion, not its actual worker result.
    // A slow highlight must never be required to conceal an already shown heading.
    const highlight = code.onHighlight;
    code.onHighlight = async (highlights, context) => {
      await blocked;
      return await highlight?.(highlights, context) ?? highlights;
    };
    setup.renderer.on("frame", capture);
    await setup.renderOnce();
    expect(code.drawUnstyledText).toBe(true);
    expect(code.isHighlighting).toBe(true);
    expect(code.plainText).toContain("## Build systems");
    expect(code.plainText).toContain("- Goals define results.");
    expect(frames.some((lines) => lines.length > 0)).toBe(true);

    release();
    await code.highlightingDone;
    await setup.renderOnce();
    expect(markdown.getChildren()[0]).toBe(code);
    expect(code.plainText).toContain("Build systems");
    expect(code.plainText).not.toContain("##");
    expect(rawSyntaxLines(setup.captureSpans().lines)).toEqual([]);

    // No mount/finalization switch: the SAME renderable is synchronously
    // overwritten with an inline-only preview when the next delta arrives.
    markdown.content += "\n- **Systems** make progress repeatable.";
    expect(markdown.getChildren()[0]).toBe(code);
    expect(markdown.streaming).toBe(true);
    expect(code.plainText).toContain("## Build systems");
  } finally {
    release();
    setup.renderer.off("frame", capture);
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    await setup.dispose();
  }
});
