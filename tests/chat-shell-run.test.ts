import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

const shutdown = mock();
const getStatusBarInput = mock(() => ({ model: "test/model" }));

const fakeController = {
  config: {
    ui: {
      markdown_rendering: false,
      syntax_highlighting: false,
      syntax_theme: "default",
      screen: "preserve",
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
  showThinking: false,
};

mock.module("../src/terminal/backend/stdin-keys.js", () => ({
  attachKeyListener: () => () => {},
}));

mock.module("../src/terminal/runtime/program.js", () => ({
  runProgram: async () => ({ model: {} }),
}));

import { runChatShell } from "../src/ui/chat-shell/run.js";
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

describe("runChatShell shutdown feedback", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    shutdown.mockReset();
    getStatusBarInput.mockClear();
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = spyOn(console, "log").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("writes Saving session to stderr on alternate mode shutdown", async () => {
    shutdown.mockResolvedValueOnce({ memory: "completed" });

    await runChatShell(fakeController as any, fakeInfo, "alternate");

    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrWrites.some((w) => w.includes("Saving session"))).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);

    const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0]));
    expect(stdoutWrites.some((w) => w.includes("resume sess-test"))).toBe(true);
  });

  it("writes background notice when shutdown reports summarizer still running", async () => {
    shutdown.mockResolvedValueOnce({ memory: "background" });

    await runChatShell(fakeController as any, fakeInfo, "alternate");

    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrWrites.some((w) => w.includes("continuing in background"))).toBe(true);
  });
});
