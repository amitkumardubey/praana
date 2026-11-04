import { describe, expect, it } from "bun:test";
import { CodeRenderable, MarkdownRenderable, type Renderable } from "@opentui/core";
import { createTerminalCapabilities, createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";
import { ATOMIC_HABITS_MARKDOWN, STREAM_MARKDOWN, chunkDeltas } from "../scripts/tui-bounce/fixture.js";
import { rawSyntaxLines } from "../scripts/tui-bounce/metrics.js";
import { buildMarkdownSyntaxStyle, releaseMarkdownSyntaxStyles } from "../src/ui/tui/transcript/markdown-theme.js";
import { RetainedMarkdownRenderable } from "../src/ui/tui/transcript/retained-markdown.js";
import { stabilizeStreamingMarkdown } from "../src/ui/tui/transcript/streaming-markdown.js";

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

function codes(root: Renderable): CodeRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof CodeRenderable ? [child] : []),
    ...codes(child),
  ]);
}

async function finishHighlights(setup: Setup): Promise<void> {
  for (let pass = 0; pass < 8; pass++) {
    await setup.renderOnce();
    const pending = codes(setup.renderer.root).filter((code) => code.isHighlighting);
    if (pending.length === 0) {
      await setup.renderOnce();
      return;
    }
    await Promise.all(pending.map((code) => code.highlightingDone));
  }
  throw new Error("markdown highlights did not settle");
}

async function captureFinished(text: string, width: number, retained: boolean, hyperlinks?: boolean) {
  // Capture the whole answer, not just its last viewport, including styles.
  const setup = await createTestRenderer({ width, height: 200, footerHeight: 0 });
  try {
    const Type = retained ? RetainedMarkdownRenderable : MarkdownRenderable;
    const markdown = new Type(setup.renderer, {
      syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene),
      streaming: retained,
      content: retained ? "" : text,
    });
    setup.renderer.root.add(markdown);
    if (retained) {
      let source = "";
      for (const delta of chunkDeltas(text, 64)) {
        source += delta;
        markdown.content = stabilizeStreamingMarkdown(source, { withholdIncomplete: true });
        await finishHighlights(setup);
      }
      // Match TranscriptEntryView's completion: full original source, then
      // streaming=false. No syntax is permanently removed from a final reply.
      markdown.content = text;
      markdown.streaming = false;
    }
    await finishHighlights(setup);
    if (hyperlinks !== undefined) {
      const capabilities = setRendererCapabilities(setup.renderer, createTerminalCapabilities({ hyperlinks }));
      setup.renderer.emit("capabilities", capabilities);
      await finishHighlights(setup);
    }
    return {
      source: markdown.content,
      chars: setup.captureCharFrame(),
      styled: JSON.stringify(setup.captureSpans()),
      height: markdown.height,
    };
  } finally {
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    await setup.dispose();
  }
}

describe("retained markdown", () => {
  it("keeps the exact previous styled buffer until a real delayed highlight is ready", async () => {
    const setup = await createTestRenderer({ width: 70, height: 12, footerHeight: 0 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const rawFrames: string[][] = [];
    const record = () => { rawFrames.push(rawSyntaxLines(setup.captureSpans().lines)); };
    try {
      const markdown = new RetainedMarkdownRenderable(setup.renderer, {
        syntaxStyle: buildMarkdownSyntaxStyle(setup.renderer.nativeScene),
        content: "## Build systems\n\n- **Goals** define results.",
        streaming: true,
      });
      setup.renderer.root.add(markdown);
      await finishHighlights(setup);
      const code = codes(markdown)[0]!;
      const previous = code.plainText;
      const styled = JSON.stringify(setup.captureSpans());
      setup.renderer.on("frame", record);
      markdown.content += "\n- **Systems** make progress repeatable.";
      expect(codes(markdown)[0]).toBe(code);
      expect(code.drawUnstyledText).toBe(false);
      expect(code.plainText).toBe(previous);
      const highlight = code.onHighlight;
      code.onHighlight = async (highlights, context) => {
        await blocked;
        return await highlight?.(highlights, context) ?? highlights;
      };
      await setup.renderOnce();
      await Bun.sleep(30);
      expect(code.isHighlighting).toBe(true);
      expect(JSON.stringify(setup.captureSpans())).toBe(styled);
      expect(rawFrames.length).toBeGreaterThan(0);
      expect(rawFrames.every((lines) => lines.length === 0)).toBe(true);
      release();
      await code.highlightingDone;
      await finishHighlights(setup);
      expect(code.plainText).toContain("Systems make progress repeatable.");
      expect(rawSyntaxLines(setup.captureSpans().lines)).toEqual([]);
    } finally {
      release();
      setup.renderer.off("frame", record);
      releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
      await setup.dispose();
    }
  });

  for (const width of [80, 110]) {
    for (const [name, text] of [["sky", STREAM_MARKDOWN], ["atomic habits", ATOMIC_HABITS_MARKDOWN]] as const) {
      it(`finishes byte-identically to upstream: ${name}, ${width} columns`, async () => {
        const upstream = await captureFinished(text, width, false);
        const retained = await captureFinished(text, width, true);
        expect(retained.source).toBe(text);
        expect(retained.chars).toBe(upstream.chars);
        expect(retained.styled).toBe(upstream.styled);
        expect(retained.height).toBe(upstream.height);
      }, { timeout: 30_000 });
    }
  }

  it("keeps final link rendering identical when terminal capabilities arrive later", async () => {
    const text = "## Links\n\nRead [the docs](https://example.com).";
    const upstream = await captureFinished(text, 80, false, true);
    const retained = await captureFinished(text, 80, true, true);
    expect(retained.chars).toBe(upstream.chars);
    expect(retained.styled).toBe(upstream.styled);
  });

  it("restores intentionally incomplete/literal syntax at completion too", async () => {
    const text = "# Finished answer\n\n**unfinished\n\n| Header | Only |\n| --- | --- |\n\n`unfinished";
    const upstream = await captureFinished(text, 80, false);
    const retained = await captureFinished(text, 80, true);
    expect(retained.source).toBe(text);
    expect(retained.chars).toBe(upstream.chars);
    expect(retained.styled).toBe(upstream.styled);
  });
});
