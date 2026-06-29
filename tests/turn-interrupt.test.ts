import { describe, it, expect } from "bun:test";
import {
  TurnAbortedError,
  TurnController,
  nextEscapeInterruptState,
  consumeEscapeBytes,
  skipEscapeSequence,
  chunkContainsCtrlC,
  ESC_INTERRUPT_WINDOW_MS,
} from "../src/turn-control.js";
import { createSystemTools } from "../src/tools/system.js";

describe("consumeEscapeBytes", () => {
  it("triggers on two Esc bytes in one chunk", () => {
    const chunk = Buffer.from([0x1b, 0x1b]);
    const result = consumeEscapeBytes(chunk, 0, 1_000);
    expect(result.triggered).toBe(true);
    expect(result.lastEscAt).toBe(0);
  });

  it("ignores arrow-key sequences", () => {
    const chunk = Buffer.from([0x1b, 0x5b, 0x41]); // Esc [ A
    const result = consumeEscapeBytes(chunk, 0, 1_000);
    expect(result.triggered).toBe(false);
    expect(result.deferred).toBe(false);
  });

  it("defers a lone Esc byte at chunk end", () => {
    const chunk = Buffer.from([0x1b]);
    const result = consumeEscapeBytes(chunk, 0, 1_000);
    expect(result.triggered).toBe(false);
    expect(result.deferred).toBe(true);
  });

  it("pairs Esc presses across chunks via timestamps", () => {
    const t0 = 1_000;
    const first = consumeEscapeBytes(Buffer.from([0x1b]), 0, t0);
    expect(first.deferred).toBe(true);

    const second = nextEscapeInterruptState(t0, t0 + 200);
    expect(second.triggered).toBe(true);
  });
});

describe("skipEscapeSequence", () => {
  it("skips CSI arrow sequences", () => {
    const chunk = Buffer.from([0x1b, 0x5b, 0x41]);
    expect(skipEscapeSequence(chunk, 0)).toBe(3);
  });
});

describe("nextEscapeInterruptState", () => {
  it("triggers on a second Esc within the window", () => {
    const t0 = 1_000;
    const first = nextEscapeInterruptState(0, t0);
    expect(first.triggered).toBe(false);
    expect(first.lastEscAt).toBe(t0);

    const second = nextEscapeInterruptState(first.lastEscAt, t0 + 200);
    expect(second.triggered).toBe(true);
    expect(second.lastEscAt).toBe(0);
  });

  it("does not trigger when Esc presses are too far apart", () => {
    const t0 = 1_000;
    const first = nextEscapeInterruptState(0, t0);
    const second = nextEscapeInterruptState(
      first.lastEscAt,
      t0 + ESC_INTERRUPT_WINDOW_MS + 1
    );
    expect(second.triggered).toBe(false);
    expect(second.lastEscAt).toBe(t0 + ESC_INTERRUPT_WINDOW_MS + 1);
  });
});

describe("chunkContainsCtrlC", () => {
  it("detects Ctrl+C byte", () => {
    expect(chunkContainsCtrlC(Buffer.from([0x03]))).toBe(true);
    expect(chunkContainsCtrlC(Buffer.from([0x1b]))).toBe(false);
  });
});

describe("TurnController", () => {
  it("begins with a fresh abort signal", () => {
    const ctrl = new TurnController();
    const signal = ctrl.begin();
    expect(signal.aborted).toBe(false);
    expect(ctrl.isActive()).toBe(true);
    expect(ctrl.inProgress).toBe(true);
    ctrl.end();
    expect(ctrl.isActive()).toBe(false);
  });

  it("aborts the active turn", () => {
    const ctrl = new TurnController();
    const signal = ctrl.begin();
    ctrl.abort();
    expect(signal.aborted).toBe(true);
    expect(ctrl.inProgress).toBe(false);
    expect(ctrl.isActive()).toBe(true);
    ctrl.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts a previous turn when beginning a new one", () => {
    const ctrl = new TurnController();
    const first = ctrl.begin();
    const second = ctrl.begin();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });
});

describe("TurnAbortedError", () => {
  it("carries partial response text", () => {
    const err = new TurnAbortedError("partial output");
    expect(err.partialResponse).toBe("partial output");
    expect(err.message).toBe("Turn interrupted");
  });
});

describe("shell abort", () => {
  it("kills a running command when the turn is aborted", async () => {
    const controller = new AbortController();
    const tools = createSystemTools({
      cwd: process.cwd(),
      getAbortSignal: () => controller.signal,
    });

    const resultPromise = tools.shell.execute({
      command: "sleep 5",
      timeout: 30_000,
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = (await resultPromise) as {
      ok: boolean;
      exitCode: number;
      stderr: string;
    };

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(130);
  }, 10_000);

  it("returns immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = createSystemTools({
      cwd: process.cwd(),
      getAbortSignal: () => controller.signal,
    });

    const result = (await tools.shell.execute({
      command: "echo hi",
      timeout: 5_000,
    })) as { ok: boolean; exitCode: number; stderr: string };

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe("Interrupted");
  });
});
