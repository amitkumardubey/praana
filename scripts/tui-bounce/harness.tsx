/**
 * Terminal-free scroll-bounce harness.
 *
 * Mounts the real transcript view (store + scrollbox + markdown entries) in
 * OpenTUI's test renderer and drives it through OpenTuiSink. After every
 * applied delta the renderer is stepped until the frame is stable. Every
 * presented frame is kept: the `frame` event when the loop emits one, otherwise
 * a snapshot taken after that `renderOnce`.
 *
 * Passes: the first paint of a delta can still be the streaming preview.
 * Tree-sitter highlight then replaces chunks and asks for another frame, and
 * sticky follow can move the scroll offset on the layout pass after the
 * content height changes. The loop stops when a pass both starts and finishes
 * with no code renderable highlighting, or at 6 passes.
 */
import { createTestRenderer } from "@opentui/core/testing";
import { CodeRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { render } from "@opentui/solid";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { OpenTuiSink } from "../../src/ui/tui/sink.js";
import type { ToastApi } from "../../src/ui/tui/shell-ui.js";
import { TranscriptProjection } from "../../src/ui/tui/transcript/projection.js";
import { createTranscriptStore, type TranscriptStoreApi } from "../../src/ui/tui/transcript/store.js";
import { releaseMarkdownSyntaxStyles } from "../../src/ui/tui/transcript/markdown-theme.js";
import { TranscriptView } from "../../src/ui/tui/transcript/view.js";
import type { TranscriptRenderOpts } from "../../src/ui/tui/transcript/opts.js";
import { STREAM_MARKDOWN, chunkDeltas, wordDeltas } from "./fixture.js";
import { measureBounce, rawSyntaxLines, visibleOf, type BounceFrame } from "./metrics.js";

const OPTS: TranscriptRenderOpts = {
  markdownRendering: true,
  syntaxTheme: "default",
  backgroundZones: false,
  useUnicode: true,
};

const TOAST: ToastApi = {
  show() {},
  clearErrors() {},
  attachConsole() {},
};

const MAX_PASSES = 6;
const HIGHLIGHT_TIMEOUT_MS = 8_000;

export interface BounceScenario {
  width: number;
  height: number;
  deltas: "words" | "chunks";
  /** Slice size for `chunks`. Default 24. */
  chunkSize?: number;
  /** Wall-clock gap between provider deltas in realtime mode. */
  arrivalMs: number;
  /** Stop after this many source deltas. Unset streams the whole fixture. */
  maxDeltas?: number;
  /** Real renderer scheduling, with no per-delta highlight drain. */
  realtime?: boolean;
  /** Defaults to the original scroll-bounce fixture. */
  text?: string;
}

export interface BounceReport {
  scenario: BounceScenario;
  applied: number;
  frames: number;
  rawSyntaxFrames: number;
  rawSyntaxExamples: string[];
  /** Public CodeRenderable state captured at the first raw frame. */
  rawState: string[];
  bounce: number;
  scrollReversals: number;
  lastRowReversals: number;
  topLineReversals: number;
  undone: number;
  heightShrinks: number;
  markdownShrinks: number;
  /** Applied deltas whose first presented frame and stable frame disagree by a line. */
  intermediateShifts: number;
  maxPasses: number;
  passHistogram: Record<number, number>;
  viewportHeight: number;
  finalScrollTop: number;
  finalScrollHeight: number;
  finalText: string;
  examples: string[];
}

export const BOUNCE_MATRIX: BounceScenario[] = [
  { width: 110, height: 40, deltas: "words", arrivalMs: 0 },
  { width: 80, height: 24, deltas: "words", arrivalMs: 0 },
  { width: 110, height: 40, deltas: "chunks", chunkSize: 8, arrivalMs: 0 },
  { width: 80, height: 24, deltas: "chunks", chunkSize: 8, arrivalMs: 0 },
];

interface Highlightable {
  isHighlighting?: boolean;
  highlightingDone?: Promise<void>;
  getChildren?: () => unknown[];
}

function walk(node: unknown, visit: (node: Highlightable) => void): void {
  if (!node || typeof node !== "object") return;
  const current = node as Highlightable;
  visit(current);
  for (const child of current.getChildren?.() ?? []) walk(child, visit);
}

async function drainHighlights(root: unknown): Promise<number> {
  const pending: Promise<void>[] = [];
  walk(root, (node) => {
    if (node.isHighlighting && node.highlightingDone) pending.push(node.highlightingDone);
  });
  if (pending.length === 0) return 0;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => setTimeout(resolve, HIGHLIGHT_TIMEOUT_MS)),
  ]);
  return pending.length;
}

function assistantTail(store: TranscriptStoreApi): string {
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const entry = store.entries[i];
    if (entry && entry.role === "assistant") return entry.text.slice(-80);
  }
  return "";
}

function scenarioDeltas(scenario: BounceScenario): string[] {
  const text = scenario.text ?? STREAM_MARKDOWN;
  const deltas = scenario.deltas === "words"
    ? wordDeltas(text)
    : chunkDeltas(text, scenario.chunkSize ?? 8);
  return scenario.maxDeltas === undefined ? deltas : deltas.slice(0, scenario.maxDeltas);
}

export function formatBounceReport(report: BounceReport): string {
  const { scenario } = report;
  const head = `${scenario.width}x${scenario.height} ${scenario.deltas}`;
  const body = [
    head,
    `applied ${report.applied} frames ${report.frames} bounce ${report.bounce} scroll ${report.scrollReversals} shrinks ${report.heightShrinks} mdShrinks ${report.markdownShrinks} lastRow ${report.lastRowReversals} top ${report.topLineReversals} undone ${report.undone} intermediate ${report.intermediateShifts}`,
    `raw-syntax frames ${report.rawSyntaxFrames}`,
    ...report.rawSyntaxExamples.map((example) => `  ${example}`),
    ...report.rawState.map((state) => `  code ${state}`),
    `passes max ${report.maxPasses} hist ${JSON.stringify(report.passHistogram)} viewport ${report.viewportHeight} scroll ${report.finalScrollTop}/${report.finalScrollHeight}`,
    ...report.examples.map((example) => `  ${example}`),
  ];
  return body.join("\n");
}

export async function runBounceScenario(scenario: BounceScenario): Promise<BounceReport> {
  const setup = await createTestRenderer({
    width: scenario.width,
    height: scenario.height,
    footerHeight: 0,
  });
  const store = createTranscriptStore();
  let applied = 0;
  const sink = new OpenTuiSink({
    ...store.mount,
    appendAssistantDelta(id, delta) {
      applied++;
      return store.mount.appendAssistantDelta(id, delta);
    },
  }, TOAST, {
    ambient: "quiet",
    showThinking: () => false,
    onSpinnerMessage: () => {},
    ctxWindowTokens: 128_000,
    engineMode: false,
    projection: new TranscriptProjection({ useUnicode: true }),
  });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  const frames: BounceFrame[] = [];
  const rawState: string[] = [];
  let record = false;
  let sawFrame = false;
  let box: ScrollBoxRenderable | null = null;

  const scrollBox = (): ScrollBoxRenderable => {
    if (box) return box;
    const found = setup.renderer.root.findDescendantById("transcript");
    if (!found) throw new Error("transcript scrollbox was not mounted");
    box = found as ScrollBoxRenderable;
    return box;
  };

  const markdownHeight = (): number => {
    let height = 0;
    walk(setup.renderer.root, (node) => {
      if (!("_blockStates" in node)) return;
      const measured = (node as { height?: number }).height;
      if (typeof measured === "number") height = measured;
    });
    return height;
  };

  const take = (): BounceFrame => {
    const scroll = scrollBox();
    const visible = visibleOf(setup.captureCharFrame());
    const rawSyntax = rawSyntaxLines(setup.captureSpans().lines);
    if (rawSyntax.length > 0 && rawState.length === 0) {
      walk(setup.renderer.root, (node) => {
        if (!(node instanceof CodeRenderable)) return;
        rawState.push(JSON.stringify({
          id: node.id,
          content: node.content,
          painted: node.plainText,
          streaming: node.streaming,
          drawUnstyledText: node.drawUnstyledText,
          isHighlighting: node.isHighlighting,
        }));
      });
    }
    return {
      rawSyntax,
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      markdownHeight: markdownHeight(),
      first: visible.first,
      last: visible.last,
      text: visible.text,
      sourceTail: assistantTail(store),
    };
  };

  const onFrame = () => {
    sawFrame = true;
    if (record) frames.push(take());
  };

  const settle = async (): Promise<number> => {
    let passes = 0;
    let followUp = false;
    while (passes < MAX_PASSES) {
      sawFrame = false;
      await setup.renderOnce();
      if (record && !sawFrame) frames.push(take());
      passes++;
      const drained = await drainHighlights(setup.renderer.root);
      if (!followUp && drained === 0) break;
      followUp = drained > 0;
      if (!followUp) break;
    }
    return passes;
  };

  try {
    await render(
      () => (
        <KeymapProvider keymap={keymap}>
          <box width="100%" height="100%" flexDirection="column">
            <TranscriptView store={store} opts={OPTS} />
          </box>
        </KeymapProvider>
      ),
      setup.renderer,
    );
    setup.renderer.on("frame", onFrame);
    await settle();
    sink.appendUser("Explain why the sky colour changes.");
    await settle();

    record = true;
    const passHistogram: Record<number, number> = {};
    let maxPasses = 0;
    let intermediateShifts = 0;

    const applyAndPaint = async (): Promise<void> => {
      const start = frames.length;
      const passes = await settle();
      passHistogram[passes] = (passHistogram[passes] ?? 0) + 1;
      maxPasses = Math.max(maxPasses, passes);
      const end = frames.length;
      if (end - start >= 2) {
        const first = frames[start]!;
        const stable = frames[end - 1]!;
        const shifted =
          Math.abs(first.scrollTop - stable.scrollTop) >= 0.5 || first.first !== stable.first;
        if (shifted) intermediateShifts++;
      }
    };

    for (const delta of scenarioDeltas(scenario)) {
      sink.onTextDelta(delta);
      if (scenario.realtime) {
        // Let the real renderer and worker race the next provider delta. The
        // frame listener stays attached throughout, including between deltas.
        await Bun.sleep(scenario.arrivalMs);
        continue;
      }
      await applyAndPaint();
    }
    if (scenario.realtime) {
      await settle();
      await setup.renderer.idle();
    }

    const metrics = measureBounce(frames);
    const last = frames[frames.length - 1];
    const scroll = scrollBox();
    return {
      scenario,
      applied,
      frames: frames.length,
      rawSyntaxFrames: metrics.rawSyntaxFrames,
      rawSyntaxExamples: metrics.rawSyntaxExamples,
      rawState,
      bounce: metrics.bounce,
      scrollReversals: metrics.scrollReversals,
      lastRowReversals: metrics.lastRowReversals,
      topLineReversals: metrics.topLineReversals,
      undone: metrics.undone,
      heightShrinks: metrics.heightShrinks,
      markdownShrinks: metrics.markdownShrinks,
      intermediateShifts,
      maxPasses,
      passHistogram,
      viewportHeight: scroll.height,
      finalScrollTop: last?.scrollTop ?? scroll.scrollTop,
      finalScrollHeight: last?.scrollHeight ?? scroll.scrollHeight,
      finalText: last?.text ?? "",
      examples: metrics.examples,
    };
  } finally {
    setup.renderer.off("frame", onFrame);
    releaseMarkdownSyntaxStyles(setup.renderer.nativeScene);
    store.dispose();
    await setup.dispose();
  }
}

export async function runBounceMatrix(
  scenarios: BounceScenario[] = BOUNCE_MATRIX,
): Promise<BounceReport[]> {
  const reports: BounceReport[] = [];
  for (const scenario of scenarios) reports.push(await runBounceScenario(scenario));
  return reports;
}
