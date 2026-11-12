/**
 * Step-pause confirm overlay. Enter continues and Esc stops only after the
 * arm delay. Ctrl+C is not consumed, including during that window, so the
 * global handler can abort the turn.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { classifyStepPauseKey, classifyYesNoKey, ConfirmOverlay, capConfirmPreview, CONFIRM_ARM_MS, confirmPreviewRows, formatConfirmQuestion } from "../src/ui/tui/overlays/confirm.js";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { focusPromptAfterConfirm } from "../src/ui/tui/run.tsx";

function PauseHarness(props: {
  overlay: ReturnType<typeof createOverlayUi>;
  armMs: number;
  onCtrlC: () => void;
  onEnter: () => void;
}) {
  useBindings(() => ({
    priority: 1,
    bindings: [
      { key: "ctrl+c", cmd: () => props.onCtrlC() },
      { key: "enter", cmd: () => props.onEnter() },
      { key: "return", cmd: () => props.onEnter() },
    ],
  }));
  return createComponent(ConfirmOverlay, { overlay: props.overlay, armMs: props.armMs });
}

async function mount(
  armMs: number,
  hooks?: {
    onCtrlC?: () => void;
    onEnter?: () => void;
    signal?: AbortSignal;
    mode?: "step" | "yesno";
    message?: string;
    preview?: readonly string[];
    width?: number;
    height?: number;
  },
) {
  const overlay = createOverlayUi();
  const pending = overlay.showConfirm(hooks?.message ?? "Continue?", hooks?.signal, {
    mode: hooks?.mode ?? "step",
    preview: hooks?.preview,
  });
  const setup = await createTestRenderer({
    width: hooks?.width ?? 80,
    height: hooks?.height ?? 24,
  });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  const onCtrlC = hooks?.onCtrlC ?? (() => {});
  const onEnter = hooks?.onEnter ?? (() => {});
  await render(
    () =>
      createComponent(KeymapProvider, {
        keymap,
        get children() {
          return createComponent(PauseHarness, { overlay, armMs, onCtrlC, onEnter });
        },
      }),
    setup.renderer,
  );
  for (let i = 0; i < 4; i++) await setup.renderOnce();
  await setup.flush();
  return { setup, pending, overlay };
}

async function stillPending(pending: Promise<boolean>): Promise<boolean> {
  const result = await Promise.race([
    pending.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
  ]);
  return result;
}

async function settledSoon(pending: Promise<boolean>): Promise<{ settled: true; value: boolean } | { settled: false }> {
  return Promise.race([
    pending.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 40)),
  ]);
}

describe("ConfirmOverlay arm delay", () => {
  it("uses a 100ms arm delay by default", () => {
    expect(CONFIRM_ARM_MS).toBe(100);
  });

  it("classifies Ctrl+C as a hard abort inside and outside the arm window", () => {
    expect(classifyStepPauseKey("c", true, false)).toBe("passthrough");
    expect(classifyStepPauseKey("c", true, true)).toBe("passthrough");
    expect(classifyStepPauseKey("escape", false, false)).toBe("ignore");
    expect(classifyStepPauseKey("esc", false, true)).toBe("stop");
    expect(classifyStepPauseKey("enter", false, false)).toBe("ignore");
    expect(classifyStepPauseKey("return", false, true)).toBe("continue");
  });

  it("shows the continue, summarise, and abort hint", async () => {
    const { setup, overlay } = await mount(0);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Enter = continue");
    expect(frame).toContain("Esc = stop and summarise");
    expect(frame).toContain("Ctrl+C = abort");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("ignores Enter while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEnter();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("ignores Esc while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEscape();
    expect(await settledSoon(pending)).toEqual({ settled: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("does not stop when a second Esc follows a palette dismiss inside the arm window", async () => {
    const overlay = createOverlayUi();
    overlay.showPalette();
    const pending = overlay.showConfirm("Continue?");
    expect(overlay.kind()).toBe("palette");
    overlay.dismiss();
    expect(overlay.kind()).toBe("confirm");
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(
      () =>
        createComponent(KeymapProvider, {
          keymap,
          get children() {
            return createComponent(ConfirmOverlay, { overlay, armMs: 60_000 });
          },
        }),
      setup.renderer,
    );
    for (let i = 0; i < 4; i++) await setup.renderOnce();
    await setup.flush();
    setup.mockInput.pressEscape();
    expect(await settledSoon(pending)).toEqual({ settled: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("lets Ctrl+C abort during the arm window without resolving the confirm itself", async () => {
    const abort = new AbortController();
    let ctrlC = 0;
    let enters = 0;
    let focuses = 0;
    const { setup, pending, overlay } = await mount(60_000, {
      signal: abort.signal,
      onCtrlC: () => {
        ctrlC += 1;
        abort.abort();
      },
      onEnter: () => {
        enters += 1;
      },
    });
    setup.mockInput.pressCtrlC();
    expect(ctrlC).toBe(1);
    const settled = await settledSoon(pending);
    expect(settled).toEqual({ settled: true, value: false });
    expect(overlay.kind()).toBe("none");
    expect(overlay.confirmPrompt()).toBeNull();
    await setup.flush();
    setup.mockInput.pressEnter();
    expect(enters).toBe(1);
    focusPromptAfterConfirm(overlay.kind(), () => {
      focuses += 1;
    });
    expect(focuses).toBe(1);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("lets Ctrl+C abort after the arm window without a confirm-owned stop", async () => {
    const abort = new AbortController();
    let ctrlC = 0;
    const { setup, pending, overlay } = await mount(0, {
      signal: abort.signal,
      onCtrlC: () => {
        ctrlC += 1;
        abort.abort();
      },
    });
    setup.mockInput.pressCtrlC();
    expect(ctrlC).toBe(1);
    expect(await settledSoon(pending)).toEqual({ settled: true, value: false });
    expect(overlay.kind()).toBe("none");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("arms Enter again for a second confirm that does not remount the overlay", async () => {
    const { setup, pending, overlay } = await mount(40);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = overlay.showConfirm("second?");
    overlay.resolveConfirm(true);
    expect(await pending).toBe(true);
    expect(overlay.confirmPrompt()?.message).toBe("second?");
    setup.mockInput.pressEnter();
    expect(await stillPending(second)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    setup.mockInput.pressEnter();
    expect(await second).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("continues on Enter once armed", async () => {
    const { setup, pending } = await mount(0);
    setup.mockInput.pressEnter();
    expect(await pending).toBe(true);
    setup.renderer.destroy();
  });

  it("stops on Esc once armed", async () => {
    const { setup, pending } = await mount(0);
    setup.mockInput.pressEscape();
    expect(await pending).toBe(false);
    setup.renderer.destroy();
  });
});

describe("classifyYesNoKey", () => {
  it("ignores every key during the arm window", () => {
    for (const key of ["y", "Y", "n", "enter", "escape", "x"]) {
      expect(classifyYesNoKey(key, false, false)).toBe("ignore");
    }
  });

  it("accepts y and Y once armed", () => {
    expect(classifyYesNoKey("y", false, true)).toBe("yes");
    expect(classifyYesNoKey("Y", false, true)).toBe("yes");
  });

  it("declines on n, Enter, and Esc once armed", () => {
    expect(classifyYesNoKey("n", false, true)).toBe("no");
    expect(classifyYesNoKey("N", false, true)).toBe("no");
    expect(classifyYesNoKey("enter", false, true)).toBe("no");
    expect(classifyYesNoKey("return", false, true)).toBe("no");
    expect(classifyYesNoKey("escape", false, true)).toBe("no");
    expect(classifyYesNoKey("esc", false, true)).toBe("no");
  });

  it("swallows other keys without answering", () => {
    for (const key of ["x", "space", "tab", "up", "1"]) {
      expect(classifyYesNoKey(key, false, true)).toBe("ignore");
    }
  });

  it("passes Ctrl+C through inside and outside the arm window", () => {
    expect(classifyYesNoKey("c", true, true)).toBe("passthrough");
    expect(classifyYesNoKey("c", true, false)).toBe("passthrough");
    // Ctrl+C keeps its abort meaning even though `c` alone does nothing.
    expect(classifyYesNoKey("c", false, true)).toBe("ignore");
  });

  it("drops the terminal-only [y/N] suffix for display", () => {
    expect(formatConfirmQuestion("Fetch https://bun.sh/docs? [y/N]", "yesno")).toBe(
      "Fetch https://bun.sh/docs?",
    );
    expect(formatConfirmQuestion("shell: rm -rf tmp", "yesno")).toBe("shell: rm -rf tmp");
    expect(formatConfirmQuestion("Used 5 steps this turn. Continue?", "step")).toBe(
      "Used 5 steps this turn. Continue?",
    );
  });
});

describe("ConfirmOverlay yes/no mode", () => {
  it("shows the risk question without [y/N] and the yes/no hint", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Fetch https://bun.sh/docs? [y/N]",
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Fetch https://bun.sh/docs?");
    expect(frame).not.toContain("[y/N]");
    expect(frame).toContain("y = yes");
    expect(frame).toContain("n / Enter / Esc = no");
    expect(frame).toContain("Ctrl+C = abort");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("accepts on y once armed", async () => {
    const { setup, pending } = await mount(0, { mode: "yesno", message: "ok? [y/N]" });
    setup.mockInput.pressKey("y");
    expect(await pending).toBe(true);
    setup.renderer.destroy();
  });

  it("declines on Enter and Esc once armed", async () => {
    const enter = await mount(0, { mode: "yesno" });
    enter.setup.mockInput.pressEnter();
    expect(await enter.pending).toBe(false);
    enter.setup.renderer.destroy();

    const esc = await mount(0, { mode: "yesno" });
    esc.setup.mockInput.pressEscape();
    expect(await esc.pending).toBe(false);
    esc.setup.renderer.destroy();
  });

  it("ignores the answer keys while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000, { mode: "yesno" });
    setup.mockInput.pressKey("y");
    setup.mockInput.pressEnter();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });
});

describe("action confirmation preview (#748)", () => {
  it("renders every line of a risk prompt that contains a blank line", async () => {
    // Risk prompts are `${class}: ${detail}` and a shell detail can be a
    // heredoc. Splitting such a prompt at its last blank line turned the head
    // of the command into a row-capped "preview", so the user approved a
    // destructive command without seeing all of it.
    const message = [
      "shell: cat <<EOF > notes.txt",
      "first line",
      "",
      "last line",
      "EOF",
    ].join("\n");
    const { setup, overlay } = await mount(0, { mode: "yesno", message });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("shell: cat <<EOF > notes.txt");
    expect(frame).toContain("first line");
    expect(frame).toContain("last line");
    expect(frame).toContain("EOF");
    expect(frame).not.toContain("more lines");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("caps a structured preview below the row budget and counts the dropped rows", () => {
    const preview = Array.from({ length: 30 }, (_, i) => `- line ${i}`);
    expect(capConfirmPreview(preview, 30)).toHaveLength(30);
    const capped = capConfirmPreview(preview, 10);
    expect(capped).toHaveLength(10);
    expect(capped[5]).toBe("... 21 more lines");
    expect(capped.at(-1)).toBe("- line 29");
    expect(capConfirmPreview(preview, 0)).toEqual([]);
  });

  it("reserves rows for the hint and the question", () => {
    // 24 rows: frame is 18, minus 4 chrome rows, minus the hint and question.
    expect(confirmPreviewRows(24, 1)).toBe(11);
    expect(confirmPreviewRows(24, 2)).toBe(10);
    // A tiny terminal still leaves the question room; the preview shrinks.
    expect(confirmPreviewRows(14, 1)).toBeLessThan(confirmPreviewRows(24, 1));
  });

  it("keeps the question and hint visible under a long preview", async () => {
    const preview = ["--- a.txt:2 (before)"];
    for (let i = 0; i < 36; i++) preview.push(`- old line ${i}`);
    preview.push("+++ a.txt:2 (after)", "+ new");
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview,
    });
    const frame = setup.captureCharFrame();
    // The question is pinned above the preview, so it cannot be pushed off.
    expect(frame).toContain("Apply edit?");
    expect(frame).not.toContain("[y/N]");
    expect(frame).toContain("y = yes");
    expect(frame).toContain("more lines");
    expect(frame).toContain("--- a.txt:2 (before)");
    expect(frame).toContain("+++ a.txt:2 (after)");
    expect(frame).toContain("+ new");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("fits only retained preview rows", async () => {
    const width = spyOn(Bun, "stringWidth");
    try {
      const preview = Array.from({ length: 200 }, (_, i) => `UNIQUE-PREVIEW-${i}`);
      const { setup, overlay } = await mount(0, { mode: "yesno", preview });
      const measured = width.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith("UNIQUE-PREVIEW-"));
      expect(measured.length).toBeLessThan(100);
      setup.renderer.destroy();
      overlay.dispose();
    } finally {
      width.mockRestore();
    }
  });

  it("shows the elided count once for a 200-line preview", async () => {
    const preview = Array.from({ length: 200 }, (_, i) => `- line ${i}`);
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview,
    });
    const frame = setup.captureCharFrame();
    expect(frame.match(/more lines/g)).toHaveLength(1);
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("y = yes");
    // The one cap keeps rows - 1 lines and spends the last row on the count of
    // exactly what is missing.
    const rows = confirmPreviewRows(24, 1, true);
    expect(frame).toContain(`... ${200 - (rows - 1)} more lines`);
    expect(frame).toContain("- line 0");
    expect(frame).toContain("- line 199");
    setup.renderer.destroy();
    overlay.dispose();
  });
});

/** Inner text of each screen row that sits between the frame borders. */
function innerRows(frame: string): string[] {
  return frame
    .split("\n")
    .filter((line) => line.includes("│"))
    // Exclude the one-column padding on either side of the frame.
    .map((line) => line.slice(line.indexOf("│") + 2, line.lastIndexOf("│") - 1));
}

const SHORT_PREVIEW = [
  "--- a.txt:2 (before)",
  "- old line one",
  "- old line two",
  "+++ a.txt:2 (after)",
  "+ new line one",
  "+ new line two",
  "+ new line three",
];

describe("action preview on a short terminal (#748)", () => {
  it("shows several preview rows at 80x24", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview: SHORT_PREVIEW,
      width: 80,
      height: 24,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("y = yes");
    // A preview-carrying prompt may use height - 2 rows, so 24 rows fit well
    // past the three-row floor.
    expect(confirmPreviewRows(24, 1, true)).toBeGreaterThanOrEqual(3);
    for (const line of SHORT_PREVIEW) expect(frame).toContain(line);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("still shows at least three preview rows at 80x14", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview: SHORT_PREVIEW,
      width: 80,
      height: 14,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("y = yes");
    expect(frame).not.toContain("preview does not fit");
    const shown = innerRows(frame).filter((row) => SHORT_PREVIEW.includes(row.trim()));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expect(frame).toContain("more lines");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("blocks approval while hidden and allows it after resizing", async () => {
    const { setup, pending, overlay } = await mount(0, {
      mode: "yesno", preview: SHORT_PREVIEW, width: 80, height: 10,
    });
    setup.mockInput.pressKey("y");
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.resize(80, 24);
    await setup.renderOnce();
    setup.mockInput.pressKey("y");
    expect(await settledSoon(pending)).toEqual({ settled: true, value: true });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("allows declining while the preview is hidden", async () => {
    const { setup, pending, overlay } = await mount(0, {
      mode: "yesno", preview: SHORT_PREVIEW, width: 80, height: 10,
    });
    setup.mockInput.pressKey("y");
    expect(await stillPending(pending)).toBe(true);
    setup.mockInput.pressKey("n");
    expect(await settledSoon(pending)).toEqual({ settled: true, value: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("says the preview does not fit at 80x10 instead of asking blind", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview: SHORT_PREVIEW,
      width: 80,
      height: 10,
    });
    const frame = setup.captureCharFrame();
    // Two rows of room left cannot hold three preview rows, so say so and keep
    // the question and the hint: an approval prompt must not hide the change.
    expect(frame).toContain("preview does not fit: enlarge the terminal to review");
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("enlarge the terminal to approve");
    expect(frame).not.toContain("--- a.txt:2 (before)");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("does not render even a single preview row when there is no room", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno", message: "Apply edit? [y/N]", preview: ["UNIQUE PREVIEW"], width: 80, height: 10,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("preview does not fit");
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("enlarge the terminal to approve");
    expect(frame).not.toContain("UNIQUE PREVIEW");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("leaves a risk prompt on the shorter frame it always had", async () => {
    // No preview, so no extra rows and no "does not fit" note even at 80x10.
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "shell: rm -rf build",
      width: 80,
      height: 10,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("shell: rm -rf build");
    expect(frame).toContain("y = yes");
    expect(frame).not.toContain("preview does not fit");
    setup.renderer.destroy();
    overlay.dispose();
  });
});

describe("action preview line width (#748)", () => {
  it("truncates a long preview line to the frame's inner width", async () => {
    const long = `- ${"x".repeat(200)}`;
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview: [long, "+ short"],
      width: 80,
      height: 24,
    });
    const frame = setup.captureCharFrame();
    const inner = innerRows(frame);
    // 64-column frame, 4 chrome columns: 60 columns of text.
    const width = 60;
    const row = inner.find((line) => line.trimStart().startsWith("- xxx"));
    expect(row).toBeDefined();
    expect(row?.trimEnd()).toHaveLength(width);
    expect(row?.trimEnd().endsWith("\u2026")).toBe(true);
    // One terminal row per preview line: the hint and question stay on screen.
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("y = yes");
    expect(frame).toContain("+ short");
    for (const line of inner) expect(line.length).toBeLessThanOrEqual(width);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("fits wide Unicode characters in one preview row", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno", message: "Apply edit? [y/N]", preview: [`- ${"界".repeat(50)}`, "+ short"],
      width: 80, height: 24,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("…");
    expect(frame).toContain("+ short");
    expect(frame).toContain("y = yes");
    const rows = innerRows(frame).filter((line) => line.includes("界"));
    expect(rows).toHaveLength(1);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("expands tabs before measuring so a tabbed line cannot wrap", async () => {
    const preview = [`- \t${"y".repeat(200)}`];
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Apply edit? [y/N]",
      preview,
      width: 80,
      height: 24,
    });
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("\t");
    const inner = innerRows(frame);
    for (const line of inner) expect(line.length).toBeLessThanOrEqual(60);
    expect(frame).toContain("Apply edit?");
    expect(frame).toContain("y = yes");
    // The tab is spaces, so the row still starts with the diff marker.
    expect(inner.some((line) => /^- +y+/.test(line.trimEnd()))).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });
});
