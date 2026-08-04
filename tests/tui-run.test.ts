/**
 * Tests for the OpenTUI runTui entry point.
 *
 * SKIPPED: runTui now mounts a Solid app via `@opentui/solid`. Rewrite against
 * `testRender` before re-enabling. Keep this file for the planned rewrite.
 *
 * IMPORTANT: When re-enabled, run in isolation because of mock.module:
 *   bun test tests/tui-run.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from "bun:test";

let capturedKeypressHandler: ((key: { name: string; ctrl: boolean; meta: boolean; shift: boolean }) => void) | null = null;
let latestEditorOnSubmit: ((text: string) => void) | null = null;
let latestEditorInner: FakeTextareaRenderable | null = null;

class FakeCliRenderer {
  destroy = mock();
  requestRender = mock();
  keyInput = {
    on: mock((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "keypress") capturedKeypressHandler = handler as never;
    }),
    off: mock(),
  };
  on = mock();
  root = { add: mock() };
}
class FakeBoxRenderable {
  add = mock(); remove = mock(); getChildren = mock(() => []); focus = mock(); blur = mock();
}
class FakeTextRenderable {
  content = "";
  constructor(_ctx: unknown, opts?: { content?: string }) { if (opts?.content) this.content = opts.content; }
}
class FakeTextareaRenderable {
  onSubmit?: (event: unknown) => void;
  plainText = ""; value = ""; focus = mock(); blur = mock();
  setText = mock((text: string) => { this.plainText = text; });
  getText = mock(() => this.plainText);
}
class FakeInputRenderable { onSubmit?: () => void; value = ""; focus = mock(); blur = mock(); }
class FakeSelectRenderable { focus = mock(); blur = mock(); options: unknown[] = []; setSelectedIndex = mock(); }
class FakeSpinner { setMessage = mock(); start = mock(); stop = mock(); }
class FakeInvertedEditor {
  inner = new FakeTextareaRenderable();
  focused = false;
  private _onSubmit?: (text: string) => void;
  constructor() {
    latestEditorInner = this.inner;
    this.inner.onSubmit = () => { if (this._onSubmit) this._onSubmit(this.inner.plainText); };
  }
  set onSubmit(handler: ((text: string) => void) | undefined) { this._onSubmit = handler; latestEditorOnSubmit = handler; }
  get onSubmit() { return this._onSubmit; }
  getText = mock(() => this.inner.plainText);
  setText = mock((text: string) => { this.inner.plainText = text; });
  focus = mock(() => { this.focused = true; });
  blur = mock(() => { this.focused = false; });
}
class FakeTranscriptContainer { loadIndex = mock(); clear = mock(); setFocused = mock(); focus = mock(); }
class FakeToastRegion { show = mock(); clearErrors = mock(); }
class FakeIdentityBar { setBackgroundZones = mock(); setInput = mock(); }
class FakeGlanceBar { setBackgroundZones = mock(); update = mock(); }

mock.module("@opentui/core", () => ({
  createCliRenderer: mock(async () => new FakeCliRenderer()),
  BoxRenderable: FakeBoxRenderable, TextRenderable: FakeTextRenderable,
  TextareaRenderable: FakeTextareaRenderable, InputRenderable: FakeInputRenderable,
  SelectRenderable: FakeSelectRenderable,
  SelectRenderableEvents: { ITEM_SELECTED: "itemSelected" },
}));
mock.module("../src/ui/tui/spinner.js", () => ({ Spinner: FakeSpinner }));
mock.module("../src/ui/tui/inverted-editor.js", () => ({ InvertedEditor: FakeInvertedEditor }));
mock.module("../src/ui/tui/transcript/container.js", () => ({ TranscriptContainer: FakeTranscriptContainer }));
mock.module("../src/ui/tui/transcript/index.js", () => ({ resolveExpandedContent: mock(async () => "") }));
mock.module("../src/ui/tui/transcript/projection.js", () => ({
  TranscriptProjection: mock(() => ({ load: mock(), apply: mock(), setUseUnicode: mock() })),
}));
mock.module("../src/ui/tui/chrome/identity-bar.js", () => ({ IdentityBar: FakeIdentityBar }));
mock.module("../src/ui/tui/chrome/glance-bar.js", () => ({ GlanceBar: FakeGlanceBar }));
mock.module("../src/ui/tui/toast-region.js", () => ({ ToastRegion: FakeToastRegion }));
mock.module("../src/ui/tui/sink.js", () => ({
  OpenTuiSink: mock((...args: unknown[]) => {
    const persistEntry = (args[3] as { persistEntry?: (entry: unknown) => void })?.persistEntry;
    return {
      nextGroup: mock(), appendUser: mock((text: string) => { persistEntry?.({ role: "user", text, timestamp: Date.now() }); }),
      onSystemLines: mock(), appendTurnFooter: mock(), appendShellRun: mock(), onFallback: mock(),
      onSlashCommandResult: null, getContextPreview: mock(() => null), clearContextPreview: mock(),
    };
  }),
}));
mock.module("../src/ui/tui/slash-command-overlay.js", () => ({
  showSlashCommandResult: mock(() => ({})), dismissSlashCommandResult: mock(),
}));
mock.module("../src/ui/tui/model-selector.js", () => ({ ModelSelector: FakeBoxRenderable }));
mock.module("../src/ui/tui/login-wizard.js", () => ({ LoginWizard: FakeBoxRenderable }));
mock.module("../src/ui/tui/logout-wizard.js", () => ({ LogoutWizard: FakeBoxRenderable }));
mock.module("../src/ui/tui/banner.js", () => ({ renderBootBanner: mock(() => ["banner line"]) }));
mock.module("../src/ui/tui/boot-summary.js", () => ({ formatTuiBootSummary: mock(() => ["boot summary"]) }));
mock.module("../src/model-listing.js", () => ({ listAllAvailableModels: mock(async () => []) }));

const defaultShutdownStatus = {
  memory: "completed" as const, turns: 3, stateObjects: 0,
  rememberCalls: 0, recallUsed: 0, learningsStored: 0,
};
const shutdownMock: Mock<() => Promise<typeof defaultShutdownStatus>> = mock(async () => ({ ...defaultShutdownStatus }));
const eventLogAppend = mock();

const fakeSession = {
  id: "sess-test", agentsContext: null, digest: null, skills: [] as unknown[],
  memoryEnabled: false, isContextEngineEnabled: () => false, isIncognito: () => false,
  getActiveModelLabel: () => "test/model", getActiveModelId: () => "test/model",
  getEffectiveProvider: () => "test", getTurnCount: () => 3,
  getGitBranch: () => null, getRepoRoot: () => "/tmp",
  getPersistentMemoryEntryCount: () => null, getInputTokens: () => 0,
  getOutputTokens: () => 0, getRecallUsedCount: () => 0,
  getContextWindowTokens: () => 128_000,
  getSessionSummary: () => ({ turns: 3, stateObjects: 0, memoriesStored: 0 }),
  setProviderOverride: mock(),
  eventLog: { append: eventLogAppend, readAll: mock(() => ({ groups: [] })) },
};

const fakeStatusBar = {
  model: "test/model", repoPath: "/tmp", cwd: "/tmp", branch: null,
  debug: false, thinking: false, memoryEnabled: false, incognito: false,
  planMode: false, contextUsedTokens: 0, contextWindowTokens: 128_000,
  memoryStats: { active: 0, soft: 0, hard: 0 }, skills: [] as string[],
  loadedSkills: null, currentTask: null, agentsContextLoaded: false,
  sessionInputTokens: 0, sessionOutputTokens: 0,
};

const fakeController = {
  config: { ui: {
    markdown_rendering: false, syntax_highlighting: false, syntax_theme: "nord",
    ambient: "inline" as const, tool_icons: "unicode" as const,
    background_zones: false, show_cost: false, banner: false,
  }},
  session: fakeSession, cwd: "/tmp", showThinking: false,
  currentModelOrDefault: () => "test/model",
  getStatusBarInput: mock(() => fakeStatusBar), shutdown: shutdownMock,
  handleUserInterrupt: mock(() => "noop" as const),
  executeSlashCommand: mock(async () => ({ action: "none" as const, lines: [] })),
  runUserTurn: mock(async () => {}),
};

import { runTui } from "../src/ui/tui/run.js";
import type { StartupInfo } from "../src/app-controller.js";

const fakeInfo: StartupInfo = {
  session: fakeSession as never, cwd: "/tmp", model: "test/model",
  bannerLines: [], recentConversationLines: [],
  transcriptBootstrap: { groups: [] }, isResume: false,
};

describe.skip("runTui (needs Solid testRender rewrite after @opentui/solid migration)", () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    shutdownMock.mockReset(); eventLogAppend.mockReset();
    fakeController.runUserTurn.mockReset();
    fakeController.runUserTurn.mockImplementation(async () => {});
    capturedKeypressHandler = null; latestEditorOnSubmit = null; latestEditorInner = null;
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => { stderrSpy.mockRestore(); exitSpy.mockRestore(); });

  it("starts TUI renderer and sets up keypress handler", async () => {
    shutdownMock.mockResolvedValueOnce({ ...defaultShutdownStatus });
    const { promise, resolve } = Promise.withResolvers<void>();
    const { createCliRenderer } = await import("@opentui/core") as { createCliRenderer: Mock };
    createCliRenderer.mockImplementationOnce(async () => { resolve(); return new FakeCliRenderer(); });

    const runPromise = runTui(fakeController as never, fakeInfo);
    await promise;
    expect(capturedKeypressHandler).toBeTypeOf("function");
    exitSpy.mockImplementationOnce((() => { throw new Error("process.exit"); }) as never);
  });

  it("persists transcript entries via the sink", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { createCliRenderer } = await import("@opentui/core") as { createCliRenderer: Mock };
    createCliRenderer.mockImplementationOnce(async () => { resolve(); return new FakeCliRenderer(); });

    await runTui(fakeController as never, fakeInfo);
    await promise;

    latestEditorOnSubmit?.("hello world");
    expect(eventLogAppend).toHaveBeenCalledWith({
      kind: "ui_transcript", actor: "kernel",
      payload: { type: "entry", entry: expect.objectContaining({ role: "user", text: "hello world" }) },
    });
  });

  it("rewrites !<command> to /shell", async () => {
    fakeController.executeSlashCommand.mockImplementation(async (input: string) => ({
      action: "none" as const, lines: [], display: "inline_transcript" as const,
    }));
    const { promise, resolve } = Promise.withResolvers<void>();
    const { createCliRenderer } = await import("@opentui/core") as { createCliRenderer: Mock };
    createCliRenderer.mockImplementationOnce(async () => { resolve(); return new FakeCliRenderer(); });

    await runTui(fakeController as never, fakeInfo);
    await promise;
    latestEditorOnSubmit?.("!git status");
    expect(fakeController.executeSlashCommand).toHaveBeenCalledWith("/shell git status");
  });

  it("ctrl+c with empty input exits", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { createCliRenderer } = await import("@opentui/core") as { createCliRenderer: Mock };
    createCliRenderer.mockImplementationOnce(async () => { resolve(); return new FakeCliRenderer(); });
    shutdownMock.mockResolvedValueOnce({ ...defaultShutdownStatus });
    fakeController.handleUserInterrupt.mockImplementation((empty: boolean) =>
      empty ? ("exit" as const) : ("clear_input" as const),
    );
    exitSpy.mockImplementation(() => undefined as never);

    const runPromise = runTui(fakeController as never, fakeInfo);
    await promise;
    capturedKeypressHandler?.({ name: "c", ctrl: true, meta: false, shift: false });
    await runPromise;
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("ctrl+c with non-empty input clears", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { createCliRenderer } = await import("@opentui/core") as { createCliRenderer: Mock };
    createCliRenderer.mockImplementationOnce(async () => { resolve(); return new FakeCliRenderer(); });
    fakeController.handleUserInterrupt.mockImplementation((empty: boolean) =>
      empty ? ("exit" as const) : ("clear_input" as const),
    );

    const runPromise = runTui(fakeController as never, fakeInfo);
    await promise;
    // Set non-empty text so handleUserInterrupt gets empty=false
    if (latestEditorInner) latestEditorInner.plainText = "hello";
    capturedKeypressHandler?.({ name: "c", ctrl: true, meta: false, shift: false });
    await runPromise;
    expect(shutdownMock).not.toHaveBeenCalled();
  });
});
