import { describe, it, expect, mock } from "bun:test";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import { UserMessageComponent } from "../src/ui/tui/transcript/components/user-message.js";
import { AssistantMessageComponent } from "../src/ui/tui/transcript/components/assistant-message.js";
import { ToolRowComponent } from "../src/ui/tui/transcript/components/tool-row.js";

const defaultOpts = {
  markdownRendering: false,
  syntaxTheme: "nord",
  backgroundZones: false,
  useUnicode: true,
};

function fakeTui() {
  return { requestRender: mock(() => {}) };
}

describe("TranscriptContainer", () => {
  it("appends retained user and assistant components as children", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);

    container.appendUser("hello", 1);
    container.appendAssistantDelta("world", 1);

    expect(container.children.length).toBeGreaterThanOrEqual(2);
    expect(container.children[0]).toBeInstanceOf(UserMessageComponent);
    const assistant = container.children.find(
      (c) => c instanceof AssistantMessageComponent,
    );
    expect(assistant).toBeDefined();
    expect((assistant as AssistantMessageComponent).getText()).toBe("world");
  });

  it("updates the same assistant component while streaming", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);

    container.appendAssistantDelta("hel", 1);
    container.appendAssistantDelta("lo", 1);

    const assistants = container.children.filter(
      (c) => c instanceof AssistantMessageComponent,
    );
    expect(assistants.length).toBe(1);
    expect((assistants[0] as AssistantMessageComponent).getText()).toBe("hello");
  });

  it("patches tool results on the pending row component", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);

    container.addToolRow("shell", { command: "true" }, 1);
    container.setToolResult(
      "shell",
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }),
      false,
    );

    const tool = container.children.find((c) => c instanceof ToolRowComponent);
    expect(tool).toBeDefined();
    expect((tool as ToolRowComponent).hasResult()).toBe(true);
  });

  it("hydrates bootstrap entries into component children", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts, [
      { id: "1", role: "user", group: 1, text: "hi" },
      {
        id: "2",
        role: "tool",
        group: 1,
        toolName: "shell",
        toolIcon: "❯",
        toolLabel: "true",
        toolPending: "running…",
        resultSummary: "ok",
      },
    ]);

    expect(container.children.some((c) => c instanceof UserMessageComponent)).toBe(
      true,
    );
    expect(container.children.some((c) => c instanceof ToolRowComponent)).toBe(
      true,
    );
  });

  it("clear removes all children and resets streaming state", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);
    container.appendUser("x", 1);
    container.clear();
    expect(container.children.length).toBe(0);
  });
});
