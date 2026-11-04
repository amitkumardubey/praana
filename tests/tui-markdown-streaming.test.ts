/**
 * OpenTUI markdown streaming regressions (PRAANA transcript).
 *
 * Uses OpenTUI's own test renderer + MarkdownRenderable directly (not the
 * Solid component path, which cannot be mounted under `bun test` here).
 *
 * - "completion keeps text visible": 0.5.10 fixed MarkdownRenderable
 *   destroying/recreating all blocks when `streaming` flips true->false
 *   (PR #1469); before that the response text was absent for several frames
 *   around the transition. The bug triggered only in top-level block mode
 *   (`internalBlockMode: "top-level"`), where the forced refresh disabled the
 *   in-place update path. Verified against 0.5.8: with this mode, the flip
 *   drops the response text from every recorded frame; coalesced mode does
 *   not reproduce it. The tests below therefore use top-level mode and
 *   assert every frame around the flip still shows the existing response
 *   text.
 * - "chunked streaming == one-shot content": appending streamed content in
 *   many small chunks must end with the same final frame as setting the full
 *   content at once.
 */
import { describe, expect, it } from "bun:test";
import { createTestRenderer, TestRecorder } from "@opentui/core/testing";
import {
  MarkdownRenderable,
  RGBA,
  SyntaxStyle,
  type RenderContext,
} from "@opentui/core";

const MD_RESPONSE = [
  "# Summary",
  "",
  "This assistant response has several paragraphs and",
  "- list items",
  "- more items",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

const CHUNKS = MD_RESPONSE.match(/[^\n]+\n?/g)!;

function makeStyle(owner: RenderContext["nativeScene"]): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromValues(1, 1, 1, 1) } },
    owner,
  );
}

function makeMarkdown(
  ctx: RenderContext,
  style: SyntaxStyle,
  streaming: boolean,
): MarkdownRenderable {
  const md = new MarkdownRenderable(ctx, {
    content: "",
    syntaxStyle: style,
    streaming,
    // Top-level block mode is the mode in which the 0.5.8 streaming-
    // completion bug reproduces (see file header); keep it for both tests.
    internalBlockMode: "top-level",
  });
  ctx.root.add(md);
  return md;
}

function normalizeFrame(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

describe("markdown streaming completion (OpenTUI 0.8.0)", () => {
  it("keeps existing response text visible in every frame while streaming flips true->false", async () => {
    const setup = await createTestRenderer({ width: 60, height: 30 });
    const style = makeStyle(setup.renderer.nativeScene);
    const md = makeMarkdown(setup.renderer, style, true);
    try {
      await setup.renderOnce();

      // Stream the response while `streaming` is still true.
      md.content = MD_RESPONSE;
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("assistant");

      // Flip streaming to false while recording every frame rendered around
      // the transition. Assert the existing text never disappears.
      const recorder = new TestRecorder(setup.renderer);
      recorder.rec();
      md.streaming = false;
      for (let i = 0; i < 5; i++) {
        await setup.renderOnce();
      }
      recorder.stop();

      const frames = recorder.recordedFrames.map((recorded) => recorded.frame);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).toContain("assistant");
        expect(frame).toContain("list items");
        expect(frame).toContain("const x = 1;");
      }
    } finally {
      await setup.dispose();
      style.destroy();
    }
  });

  it("appending streamed content in many small chunks ends with the same final frame as setting the full content at once", async () => {
    // Chunked path: append one line at a time while streaming.
    const chunked = await createTestRenderer({ width: 60, height: 30 });
    const chunkedStyle = makeStyle(chunked.renderer.nativeScene);
    const chunkedMd = makeMarkdown(chunked.renderer, chunkedStyle, true);
    try {
      await chunked.renderOnce();
      for (const chunk of CHUNKS) {
        chunkedMd.content += chunk;
        await chunked.renderOnce();
      }
      chunkedMd.streaming = false;
      for (let i = 0; i < 5; i++) {
        await chunked.renderOnce();
      }
      const chunkedFrame = normalizeFrame(chunked.captureCharFrame());

      // One-shot path: the full content set at once, also while streaming.
      const oneShot = await createTestRenderer({ width: 60, height: 30 });
      const oneShotStyle = makeStyle(oneShot.renderer.nativeScene);
      const oneShotMd = makeMarkdown(oneShot.renderer, oneShotStyle, true);
      try {
        await oneShot.renderOnce();
        oneShotMd.content = MD_RESPONSE;
        await oneShot.renderOnce();
        oneShotMd.streaming = false;
        for (let i = 0; i < 5; i++) {
          await oneShot.renderOnce();
        }
        const oneShotFrame = normalizeFrame(oneShot.captureCharFrame());

        expect(chunkedFrame).toEqual(oneShotFrame);
      } finally {
        await oneShot.dispose();
        oneShotStyle.destroy();
      }
    } finally {
      await chunked.dispose();
      chunkedStyle.destroy();
    }
  });
});
