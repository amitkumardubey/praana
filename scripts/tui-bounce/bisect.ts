/**
 * Isolate which layer shrinks while a markdown answer grows.
 *
 *   bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/bisect.ts
 *   bun --preload ./tests/helpers/solid-client.ts scripts/tui-bounce/bisect.ts markdown
 *
 * Modes:
 *   markdown       MarkdownRenderable, streaming on, no scrollbox
 *   markdown-off   same, with streaming off
 *   scroll-md      sticky-bottom scrollbox around the markdown renderable
 *   scroll-plain   same scrollbox around a plain text node of the raw source
 *   complete       streaming markdown, but only blank-line-separated blocks
 */
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { MarkdownRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { buildMarkdownSyntaxStyle, releaseMarkdownSyntaxStyles } from "../../src/ui/tui/transcript/markdown-theme.js";
import { STREAM_MARKDOWN, chunkDeltas, wordDeltas } from "./fixture.js";

type Mode = "markdown" | "markdown-off" | "scroll-md" | "scroll-plain" | "complete";

const MODES: Mode[] = ["markdown", "markdown-off", "scroll-md", "scroll-plain", "complete"];

function arg(index: number, fallback: string): string {
  return process.argv[index] ?? fallback;
}

const width = Number(arg(2, "80"));
const height = Number(arg(3, "24"));
const requested = arg(4, "all");
const kind = arg(5, "chunks");
const chunkSize = Number(arg(6, "8"));

if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("width and height must be numbers");

function deltasFor(mode: Mode): string[] {
  if (mode === "complete") {
    const blocks = STREAM_MARKDOWN.split(/\n\n/);
    return blocks.map((block, index) => (index === blocks.length - 1 ? block : `${block}\n\n`));
  }
  return kind === "words" ? wordDeltas(STREAM_MARKDOWN) : chunkDeltas(STREAM_MARKDOWN, chunkSize);
}

interface Highlightable {
  isHighlighting?: boolean;
  highlightingDone?: Promise<void>;
  getChildren?: () => unknown[];
}

async function settle(setup: TestRendererSetup): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    await setup.renderOnce();
    const pending: Promise<void>[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const current = node as Highlightable;
      if (current.isHighlighting && current.highlightingDone) pending.push(current.highlightingDone);
      for (const child of current.getChildren?.() ?? []) walk(child);
    };
    walk(setup.renderer.root);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => setTimeout(resolve, 8000)),
    ]);
  }
}

function reversals(values: number[], epsilon = 0): { shrinks: number; reversals: number } {
  let shrinks = 0;
  let reversals = 0;
  let prev = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i]! - values[i - 1]!;
    if (delta < -epsilon) shrinks++;
    const sign = Math.abs(delta) <= epsilon ? 0 : Math.sign(delta);
    if (sign === 0) continue;
    if (prev !== 0 && sign !== prev) reversals++;
    prev = sign;
  }
  return { shrinks, reversals };
}

async function runMode(mode: Mode): Promise<void> {
  const setup = await createTestRenderer({ width, height, footerHeight: 0 });
  const style = buildMarkdownSyntaxStyle(setup.renderer.nativeScene, `bisect-${mode}`);
  const heights: number[] = [];
  const scrolls: number[] = [];
  const notes: string[] = [];
  let text = "";

  try {
    let scroll: ScrollBoxRenderable | null = null;
    let markdown: MarkdownRenderable | null = null;
    let plain: TextRenderable | null = null;
    const contentWidth = Math.max(10, width - 4);

    if (mode === "scroll-plain") {
      scroll = new ScrollBoxRenderable(setup.renderer, {
        id: "transcript",
        width,
        height,
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
      });
      plain = new TextRenderable(setup.renderer, { id: "plain", content: "", width: "100%" });
      scroll.add(plain);
      setup.renderer.root.add(scroll);
    } else {
      markdown = new MarkdownRenderable(setup.renderer, {
        id: "md",
        width: mode === "scroll-md" ? "100%" : contentWidth,
        content: "",
        streaming: mode !== "markdown-off",
        syntaxStyle: style,
      });
      if (mode === "scroll-md") {
        scroll = new ScrollBoxRenderable(setup.renderer, {
          id: "transcript",
          width,
          height,
          stickyScroll: true,
          stickyStart: "bottom",
          scrollY: true,
        });
        scroll.add(markdown);
        setup.renderer.root.add(scroll);
      } else {
        setup.renderer.root.add(markdown);
      }
    }

    await settle(setup);
    let pending = "";
    const flush = async () => {
      text += pending;
      pending = "";
      if (markdown) markdown.content = text;
      if (plain) plain.content = text;
      await setup.renderOnce();
      const pass1 = markdown?.height ?? plain?.height ?? 0;
      const scroll1 = scroll?.scrollTop ?? 0;
      await settle(setup);
      const stable = markdown?.height ?? plain?.height ?? 0;
      const scroll2 = scroll?.scrollTop ?? 0;
      heights.push(pass1);
      scrolls.push(scroll1);
      if (stable !== pass1 || Math.abs(scroll2 - scroll1) >= 0.5) {
        heights.push(stable);
        scrolls.push(scroll2);
        if (notes.length < 4 && stable !== pass1) {
          notes.push(`pass ${pass1}→${stable} scroll ${scroll1}→${scroll2} tail ${JSON.stringify(text.slice(-70))}`);
        }
      } else if (heights.length >= 2 && stable < heights[heights.length - 2]!) {
        if (notes.length < 6) {
          notes.push(`height ${heights[heights.length - 2]}→${stable} tail ${JSON.stringify(text.slice(-70))}`);
        }
      }
    };

    for (const delta of deltasFor(mode)) {
      pending += delta;
      await flush();
    }

    const heightStats = reversals(heights);
    const scrollStats = reversals(scrolls, 0.5);
    console.log(
      `${mode} ${width}x${height} ${mode === "complete" ? "blocks" : kind} heightRev ${heightStats.reversals} shrinks ${heightStats.shrinks} scrollRev ${scrollStats.reversals} finalH ${heights.at(-1) ?? 0} scroll ${scroll?.scrollTop ?? 0}/${scroll?.scrollHeight ?? 0}`,
    );
    for (const note of notes) console.log(`  ${note}`);
  } finally {
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    style.destroy();
    await setup.dispose();
  }
}

const modes: Mode[] = requested === "all" ? MODES : [requested as Mode];
for (const mode of modes) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  await runMode(mode);
}
