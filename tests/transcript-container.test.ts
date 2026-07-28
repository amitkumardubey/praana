import { describe, it, expect, mock } from "bun:test";
import { Spacer } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { TranscriptGroup } from "../src/ui/tui/transcript/index.js";
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

function group(groupNum: number, entries: TranscriptGroup["entries"]): TranscriptGroup {
  return { group: groupNum, entries };
}

function makeContainer() {
  const tui = fakeTui();
  const container = new TranscriptContainer(tui as never, defaultOpts, {
    overscanGroups: 1,
    pageSizeGroups: 2,
  });
  return { tui, container };
}

function manyGroups(count: number): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (let i = 1; i <= count; i++) {
    groups.push(
      group(i, [
        { id: `user-${i}`, role: "user", group: i, text: `turn ${i}` },
        { id: `assistant-${i}`, role: "assistant", group: i, text: `reply ${i}` },
      ]),
    );
  }
  return groups;
}

describe("TranscriptContainer", () => {
  it("hydrates bootstrap entries into component children", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [
        group(1, [
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
        ]),
      ],
    });

    expect(container.children.some((c) => c instanceof UserMessageComponent)).toBe(
      true,
    );
    expect(container.children.some((c) => c instanceof ToolRowComponent)).toBe(
      true,
    );
  });

  it("mounts only the newest visible range on resume", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });

    // Budget = 2 + 1*2 = 4 groups, so we mount groups 17..20.
    const range = container.getMountedGroupRange();
    expect(range.start).toBe(16);
    expect(range.end).toBe(20);
  });

  it("pages in earlier groups on scroll up", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });

    container.onScrollUp();
    const range = container.getMountedGroupRange();
    expect(range.start).toBe(14);
    expect(range.end).toBe(20);
  });

  it("pages in later groups on scroll down after eviction", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });

    container.onScrollUp();
    container.onScrollUp();
    container.onScrollDown();
    const range = container.getMountedGroupRange();
    expect(range.end).toBe(20);
    expect(range.start).toBeLessThan(16);
  });

  it("re-enables tail-follow when scrolled back to the newest group", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });
    container.onScrollUp();
    container.onScrollDown();

    // New tail append should now mount immediately.
    container.appendEntry({
      id: "user-21",
      role: "user",
      group: 21,
      text: "turn 21",
    });
    expect(container.getMountedGroupRange().end).toBe(21);
  });

  it("does not tail-follow while reading older history", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });
    container.onScrollUp();

    container.appendEntry({
      id: "user-21",
      role: "user",
      group: 21,
      text: "turn 21",
    });
    expect(container.getMountedGroupRange().end).toBeLessThan(21);
  });

  it("keeps mounted group count bounded while traversing history", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(100) });

    for (let i = 0; i < 50; i++) container.onScrollUp();

    const range = container.getMountedGroupRange();
    expect(range.end - range.start).toBeLessThanOrEqual(6);
  });

  it("hydrates turn footer entries with trailing spacing", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [
        group(1, [
          { id: "user-1", role: "user", group: 1, text: "hello" },
          { id: "footer-1", role: "turn_footer", group: 1, text: "✓ 1.0s" },
        ]),
      ],
    });

    const footerIndex = container.children.findIndex(
      (c) => c instanceof TurnFooterComponent,
    );
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(container.children[footerIndex + 1]).toBeInstanceOf(Spacer);
  });

  it("inserts a spacer between consecutive tool rows", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [
        group(1, [
          {
            id: "tool-1",
            role: "tool",
            group: 1,
            toolName: "read_file",
            toolIcon: "◇",
            toolLabel: "read src/a.ts",
            toolPending: "running…",
            resultSummary: "10 lines",
          },
          {
            id: "tool-2",
            role: "tool",
            group: 1,
            toolName: "read_file",
            toolIcon: "◇",
            toolLabel: "read src/b.ts",
            toolPending: "running…",
            resultSummary: "20 lines",
          },
        ]),
      ],
    });

    const toolIndices = container.children
      .map((child, index) => (child instanceof ToolRowComponent ? index : -1))
      .filter((index) => index >= 0);
    expect(toolIndices).toHaveLength(2);
    expect(container.children[toolIndices[1]! - 1]).toBeInstanceOf(Spacer);
  });

  it("clear removes all children and resets virtual state", () => {
    const { container } = makeContainer();
    container.loadIndex({ groups: manyGroups(20) });
    container.clear();
    expect(container.children.length).toBe(0);
    expect(container.getTotalGroups()).toBe(0);
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

  it("renders thinking collapsed by default", () => {
    const thinking = new ThinkingMessageComponent("line1\nline2\nline3", defaultOpts);
    thinking.setExpanded(false);
    thinking.setDisplayedLines(2);

    const rendered = thinking.render(120).map(stripAnsi).join("\n");
    expect(rendered).toContain("collapsed");
  });

  it("updates assistant text in place via appendAssistantDelta", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [group(1, [{ id: "assistant-1", role: "assistant", group: 1, text: "Hel" }])],
    });
    const component = container.children.find((c) => c instanceof AssistantMessageComponent);

    container.appendAssistantDelta("assistant-1", "lo");

    expect(component).toBeDefined();
    expect(component).toBeInstanceOf(AssistantMessageComponent);
    expect((component as AssistantMessageComponent).getText()).toBe("Hello");
  });

  it("updates thinking text in place via appendThinkingDelta", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [group(1, [{ id: "thinking-1", role: "thinking", group: 1, text: "thin" }])],
    });
    const component = container.children.find((c) => c instanceof ThinkingMessageComponent);

    container.appendThinkingDelta("thinking-1", "king");

    expect(component).toBeDefined();
    expect((component as ThinkingMessageComponent).getText()).toBe("thinking");
  });

  it("patches tool results in place via patchToolResult", () => {
    const { container } = makeContainer();
    container.loadIndex({
      groups: [
        group(1, [
          {
            id: "tool-1",
            role: "tool",
            group: 1,
            toolName: "read_file",
            toolIcon: "◇",
            toolLabel: "read src/a.ts",
            toolPending: "running…",
          },
        ]),
      ],
    });
    const component = container.children.find((c) => c instanceof ToolRowComponent);

    container.patchToolResult("tool-1", {
      id: "tool-1",
      role: "tool",
      group: 1,
      toolName: "read_file",
      toolIcon: "◇",
      toolLabel: "read src/a.ts",
      toolPending: "running…",
      resultSummary: "10 lines",
      resultBody: undefined,
      isError: false,
    });

    expect(component).toBeDefined();
    expect((component as ToolRowComponent).getResultSummary()).toBe("10 lines");
  });
});
