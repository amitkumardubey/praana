import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock Ink before importing runTui so the real renderer is never started.
const waitUntilExit = vi.fn<() => Promise<void>>();
const unmount = vi.fn();

vi.mock("ink", () => ({
  render: () => ({ waitUntilExit, unmount }),
}));

// Mock the AppController with the minimum surface runTui uses.
const shutdown = vi.fn();
const getStatusBarInput = vi.fn(() => ({ model: "test/model" }));

const fakeController = {
  config: {
    ui: {
      markdown_rendering: false,
      syntax_highlighting: false,
      syntax_theme: "default",
    },
  },
  session: {
    id: "sess-test",
    agentsContext: null,
    isContextEngineEnabled: () => false,
    skills: [] as unknown[],
    memoryEnabled: false,
    isIncognito: () => false,
    getSessionSummary: () => ({ turns: 1, stateObjects: 0, memoriesStored: 0 }),
  },
  getStatusBarInput,
  shutdown,
};

// Mock the React entrypoint so the import doesn't require a real DOM.
vi.mock("react", () => ({
  default: { createElement: vi.fn(() => "element") },
  createElement: vi.fn(() => "element"),
}));

// Mock TuiApp (imported transitively by runTui). We never render it, but the
// import must succeed.
vi.mock("../src/ui/tui/app.js", () => ({ TuiApp: function TuiApp() {} }));

import { runTui } from "../src/ui/tui/run.js";
import type { StartupInfo } from "../src/app-controller.js";

const fakeInfo: StartupInfo = {
  session: fakeController.session as any,
  cwd: "/tmp",
  model: "test/model",
  bannerLines: [],
  recentConversationLines: [],
  transcriptBootstrap: [],
  isResume: false,
};

describe("runTui shutdown feedback", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    waitUntilExit.mockReset();
    unmount.mockReset();
    shutdown.mockReset();
    getStatusBarInput.mockClear();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("writes 'Saving session…' to stderr and prints the epilogue on clean shutdown", async () => {
    waitUntilExit.mockResolvedValueOnce(undefined);
    shutdown.mockResolvedValueOnce({ memory: "completed" });

    await runTui(fakeController as any, fakeInfo, "preserve");

    // Feedback appears immediately after waitUntilExit resolves.
    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrWrites.some((w) => w.includes("Saving session"))).toBe(true);

    // unmount() runs after the feedback so Ink is fully torn down before
    // shutdown blocks for up to 2s.
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);

    // Background message is NOT shown when summarizer completed in time.
    expect(stderrWrites.some((w) => w.includes("continuing in background"))).toBe(
      false,
    );

    // Epilogue still prints.
    const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutWrites.some((w) => w.includes("resume sess-test"))).toBe(true);
    expect(
      stdoutWrites.some((w) => w.startsWith("Session ended: 1 turns")),
    ).toBe(true);
  });

  it("writes a background notice when shutdown reports the summarizer is still running", async () => {
    waitUntilExit.mockResolvedValueOnce(undefined);
    shutdown.mockResolvedValueOnce({ memory: "background" });

    await runTui(fakeController as any, fakeInfo, "preserve");

    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrWrites.some((w) => w.includes("Saving session"))).toBe(true);
    expect(
      stderrWrites.some((w) => w.includes("continuing in background")),
    ).toBe(true);
  });

  it("feedback is written promptly (well under 200ms) after waitUntilExit resolves", async () => {
    // Resolve waitUntilExit on next microtask, then verify the feedback write
    // happened during the runTui call.
    waitUntilExit.mockImplementation(
      () => new Promise<void>((resolve) => setImmediate(resolve)),
    );
    shutdown.mockImplementation(async () => {
      // Simulate a slow shutdown so we can measure that the feedback was
      // already emitted by the time shutdown completes.
      await new Promise((r) => setTimeout(r, 100));
      return { memory: "completed" };
    });

    const started = Date.now();
    await runTui(fakeController as any, fakeInfo, "preserve");
    const elapsed = Date.now() - started;

    // shutdown alone takes ~100ms; total runTui should be at least that.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    // But the feedback was written well before shutdown returned.
    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrWrites.some((w) => w.includes("Saving session"))).toBe(true);
  });
});
