import { describe, it, expect, mock } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import stripAnsi from "strip-ansi";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import type { TranscriptGroup } from "../src/ui/tui/transcript/index.js";
import { UserMessageComponent } from "../src/ui/tui/transcript/components/user-message.js";
import { AssistantMessageComponent } from "../src/ui/tui/transcript/components/assistant-message.js";
import { ToolRowComponent } from "../src/ui/tui/transcript/components/tool-row.js";
import { ThinkingMessageComponent } from "../src/ui/tui/transcript/components/thinking-message.js";
import { TurnFooterComponent } from "../src/ui/tui/transcript/components/turn-footer.js";
import { BoxRenderable } from "@opentui/core";

const defaultOpts = {
  markdownRendering: false,
  syntaxTheme: "nord",
  backgroundZones: false,
  useUnicode: true,
};

function group(groupNum: number, entries: TranscriptGroup["entries"]): TranscriptGroup {
  return { group: groupNum, entries };
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
  it("hydrates bootstrap entries into component children", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts, {
        overscanGroups: 1,
        pageSizeGroups: 2,
      });
      setup.renderer.root.add(container);
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
      await setup.renderOnce();

      const children = container.children;
      expect(children.some((c) => c instanceof UserMessageComponent)).toBe(true);
      expect(children.some((c) => c instanceof ToolRowComponent)).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("appends entries and auto-scrolls to the tail", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.appendEntry({
        id: "user-1",
        role: "user",
        group: 1,
        text: "hello",
      });
      await setup.renderOnce();
      const children = container.children;
      expect(children.some((c) => c instanceof UserMessageComponent)).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("inserts a gap spacer between consecutive tool rows", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.appendEntry({
        id: "tool-1",
        role: "tool",
        group: 1,
        toolName: "read_file",
        toolIcon: "◇",
        toolLabel: "read src/a.ts",
        toolPending: "running…",
        resultSummary: "10 lines",
      });
      container.appendEntry({
        id: "tool-2",
        role: "tool",
        group: 1,
        toolName: "read_file",
        toolIcon: "◇",
        toolLabel: "read src/b.ts",
        toolPending: "running…",
        resultSummary: "20 lines",
      });
      await setup.renderOnce();

      const children = container.children;
      const toolIndices = children
        .map((child, index) => (child instanceof ToolRowComponent ? index : -1))
        .filter((index) => index >= 0);
      expect(toolIndices).toHaveLength(2);
      expect(children[toolIndices[1]! - 1]).toBeInstanceOf(BoxRenderable);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("clear removes all children and resets state", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({ groups: manyGroups(5) });
      container.clear();
      expect(container.children.length).toBe(0);
      expect(container.getTotalGroups()).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders tool rows compactly without accent gutters or blank padding", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const tool = new ToolRowComponent(
        setup.renderer,
        {
          toolName: "read_file",
          toolIcon: "◇",
          toolLabel: "read src/turn.ts",
          toolPending: "running…",
          resultSummary: "60 lines",
        },
        defaultOpts,
      );
      setup.renderer.root.add(tool);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      const lines = frame.split("\n").map(stripAnsi);
      expect(lines.some((l) => l.includes("◇ read src/turn.ts 60 lines"))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders thinking collapsed by default", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const thinking = new ThinkingMessageComponent(setup.renderer, "line1\nline2\nline3", defaultOpts);
      thinking.setExpanded(false);
      thinking.setDisplayedLines(2);
      setup.renderer.root.add(thinking);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("collapsed");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("updates assistant text in place via appendAssistantDelta", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({
        groups: [group(1, [{ id: "assistant-1", role: "assistant", group: 1, text: "Hel" }])],
      });
      await setup.renderOnce();

      const component = container.children.find((c) => c instanceof AssistantMessageComponent);
      expect(component).toBeDefined();

      container.appendAssistantDelta("assistant-1", "lo");
      await setup.renderOnce();

      expect((component as AssistantMessageComponent).getText()).toBe("Hello");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("updates thinking text in place via appendThinkingDelta", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({
        groups: [group(1, [{ id: "thinking-1", role: "thinking", group: 1, text: "thin" }])],
      });
      await setup.renderOnce();

      const component = container.children.find((c) => c instanceof ThinkingMessageComponent);
      expect(component).toBeDefined();

      container.appendThinkingDelta("thinking-1", "king");
      await setup.renderOnce();

      expect((component as ThinkingMessageComponent).getText()).toBe("thinking");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("patches tool results in place via patchToolResult", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
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
      await setup.renderOnce();

      const component = container.children.find((c) => c instanceof ToolRowComponent);
      expect(component).toBeDefined();

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

      expect((component as ToolRowComponent).getResultSummary()).toBe("10 lines");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("selects the last entry when focus mode is enabled", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({ groups: manyGroups(5) });
      container.setFocused(true);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(container.focusMode).toBe(true);
      expect(frame).toContain("reply 5");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("navigates selection up and down in focus mode", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({ groups: manyGroups(5) });
      container.setFocused(true);
      await setup.renderOnce();

      container.handleInput("\x1b[A");
      container.handleInput("\x1b[A");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("turn 5");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("toggles thinking row expansion in focus mode", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({
        groups: [
          group(1, [
            { id: "user-1", role: "user", group: 1, text: "hi" },
            {
              id: "think-1",
              role: "thinking",
              group: 1,
              text: "line1\nline2\nline3",
              expandable: true,
            },
          ]),
        ],
      });
      container.setFocused(true);
      await setup.renderOnce();

      let component = container.children.find(
        (c) => c instanceof ThinkingMessageComponent,
      ) as ThinkingMessageComponent | undefined;
      expect(component?.isExpanded()).toBe(false);

      container.handleInput("\r");
      await setup.renderOnce();
      component = container.children.find(
        (c) => c instanceof ThinkingMessageComponent,
      ) as ThinkingMessageComponent | undefined;
      expect(component?.isExpanded()).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("resolves tool body lazily when expanding in focus mode", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const onExpand = mock(() => Promise.resolve({ ok: true, text: "full body" }));
      const container = new TranscriptContainer(
        setup.renderer,
        defaultOpts,
        { overscanGroups: 1, pageSizeGroups: 2 },
        { onExpand },
      );
      setup.renderer.root.add(container);
      container.loadIndex({
        groups: [
          group(1, [
            { id: "user-1", role: "user", group: 1, text: "hi" },
            {
              id: "tool-1",
              role: "tool",
              group: 1,
              toolName: "read_file",
              toolIcon: "◇",
              toolLabel: "read src/a.ts",
              toolPending: "running…",
              resultSummary: "ok",
              expandable: true,
              sourceEventId: "ev-1",
            },
          ]),
        ],
      });
      container.setFocused(true);
      await setup.renderOnce();

      container.handleInput("\r");
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onExpand).toHaveBeenCalled();
      const component = container.children.find(
        (c) => c instanceof ToolRowComponent,
      ) as ToolRowComponent | undefined;
      expect(component?.isExpanded()).toBe(true);
      expect(component?.getResultBody()).toBe("full body");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("blurs focus mode on escape", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const container = new TranscriptContainer(setup.renderer, defaultOpts);
      setup.renderer.root.add(container);
      container.loadIndex({ groups: manyGroups(5) });
      container.setFocused(true);
      container.handleInput("\x1b");
      expect(container.focusMode).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });
});