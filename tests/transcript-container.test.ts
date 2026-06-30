import { describe, it, expect, mock } from "bun:test";
import { Spacer } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import { UserMessageComponent } from "../src/ui/tui/transcript/components/user-message.js";
import { AssistantMessageComponent } from "../src/ui/tui/transcript/components/assistant-message.js";
import { ToolRowComponent } from "../src/ui/tui/transcript/components/tool-row.js";
import { ThinkingMessageComponent } from "../src/ui/tui/transcript/components/thinking-message.js";
import { TurnFooterComponent } from "../src/ui/tui/transcript/components/turn-footer.js";

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

  it("replaces rendered children from semantic entries", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);

    container.renderEntries([
      { id: "user-1", role: "user", group: 1, text: "hello" },
      { id: "assistant-1", role: "assistant", group: 1, text: "hi" },
    ]);

    expect(container.children.some((c) => c instanceof UserMessageComponent)).toBe(
      true,
    );
    expect(
      container.children.some((c) => c instanceof AssistantMessageComponent),
    ).toBe(true);

    container.renderEntries([
      { id: "user-2", role: "user", group: 2, text: "second" },
    ]);

    const users = container.children.filter(
      (c) => c instanceof UserMessageComponent,
    );
    expect(users.length).toBe(1);
    expect(
      container.children.some((c) => c instanceof AssistantMessageComponent),
    ).toBe(false);
  });

  it("hydrates turn footer entries with trailing spacing", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);

    container.renderEntries([
      { id: "user-1", role: "user", group: 1, text: "hello" },
      { id: "footer-1", role: "turn_footer", group: 1, text: "✓ 1.0s" },
    ]);

    const footerIndex = container.children.findIndex(
      (c) => c instanceof TurnFooterComponent,
    );
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(container.children[footerIndex + 1]).toBeInstanceOf(Spacer);
  });

  it("clear removes all children and resets streaming state", () => {
    const tui = fakeTui();
    const container = new TranscriptContainer(tui as never, defaultOpts);
    container.renderEntries([{ id: "x", role: "user", group: 1, text: "x" }]);
    container.clear();
    expect(container.children.length).toBe(0);
  });

  it("renders tool rows compactly without accent gutters or blank padding", () => {
    const tool = new ToolRowComponent(
      {
        toolName: "read_file",
        toolIcon: "◇",
        toolLabel: "read src/turn.ts",
        toolPending: "running…",
        resultSummary: "60 lines",
      },
      defaultOpts,
    );

    const lines = tool.render(80).map(stripAnsi);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("◇ read src/turn.ts 60 lines");
    expect(lines[0]).not.toContain("▌");
  });

  it("renders the full thinking text instead of only a preview", () => {
    const text = [
      "First I will inspect the input path and identify the relevant module.",
      "Then I will compare the current rendering behavior with the expected behavior.",
      "Finally I will implement the smallest fix and verify it with tests.",
    ].join("\n");
    const thinking = new ThinkingMessageComponent(text, defaultOpts);

    const rendered = thinking.render(120).map(stripAnsi).join("\n");

    expect(rendered).toContain("First I will inspect the input path");
    expect(rendered).toContain("Then I will compare the current rendering behavior");
    expect(rendered).toContain("Finally I will implement the smallest fix");
  });
});
